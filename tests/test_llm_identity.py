"""Configuration identity must survive the modern/legacy mobile adapter seam."""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from server.app import (
    _attach_requested_providers,
    _compact_project_listing,
    _retry_payload,
    _route_allowed,
    conversation_task_providers,
    create_app,
)
import test_server as fixtures
from test_server import FakeRuntimeHttp, FakeRuntimeSocket, command_result, task_end, task_events


class LlmIdentityTest(unittest.TestCase):
    CONVERSATION_ID = fixtures.ConversationRunConfigTest.CONVERSATION_ID

    def test_modern_identity_is_aliased_for_old_phones_without_reading_disk(self):
        payload = {"conversation_id": self.CONVERSATION_ID, "tasks": [{
            "task_id": "task-1", "request_llm_config_id": "oauth-record", "request_provider": "api-record",
            "requested_provider": "stale-api-record", "provider_key": "openai", "model": "gpt-6.1-terra",
        }]}
        with patch("server.app.conversation_task_providers") as disk:
            enriched = _attach_requested_providers(payload)
        disk.assert_not_called()
        self.assertEqual(enriched["tasks"][0]["request_llm_config_id"], "oauth-record")
        self.assertEqual(enriched["tasks"][0]["requested_provider"], "oauth-record")
        self.assertEqual(enriched["tasks"][0]["request_provider"], "oauth-record")

    def test_nested_modern_identity_is_aliased_for_old_phones(self):
        payload = {"conversation_id": self.CONVERSATION_ID, "tasks": [{
            "task_id": "task-1", "request_options": {"llm_config_id": "oauth-record", "provider": "api-record"},
        }]}
        self.assertEqual(_attach_requested_providers(payload)["tasks"][0]["requested_provider"], "oauth-record")

    def test_modern_journal_and_snapshot_read_exact_id_before_legacy_provider(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "conversation_deltas").mkdir()
            (home / "conversations").mkdir()
            (home / "conversation_deltas" / f"{self.CONVERSATION_ID}.jsonl").write_text(json.dumps({"task": {
                "task_id": "task-2", "request_options": {"llm_config_id": "oauth-record", "provider": "api-record"},
            }}) + "\n")
            (home / "conversations" / f"{self.CONVERSATION_ID}.json").write_text(json.dumps({"tasks": [{
                "task_id": "task-1", "request_options": {"llm_config_id": "snapshot-oauth", "provider": None},
            }]}))
            with patch.dict("os.environ", {"HAISH_RUNTIME_HOME": str(home)}):
                self.assertEqual(conversation_task_providers(self.CONVERSATION_ID), {
                    "task-1": "snapshot-oauth", "task-2": "oauth-record",
                })

    def test_compact_listing_keeps_oauth_and_api_identity_separate(self):
        payload = {"projects": [{"conversations": [{"last_task_id": "oauth-task", "tasks": [
            {"task_id": "api-task", "model": "same-model", "provider_key": "openai", "request_llm_config_id": "api-record"},
            {"task_id": "oauth-task", "model": "same-model", "provider_key": "openai", "request_llm_config_id": "oauth-record"},
        ]}]}]}
        compact = _compact_project_listing(payload)
        self.assertEqual(compact["projects"][0]["conversations"][0]["tasks"][0]["request_llm_config_id"], "oauth-record")
        self.assertEqual({t["request_llm_config_id"] for t in compact["model_catalog_tasks"]}, {"oauth-record", "api-record"})

    def test_retry_preserves_modern_identity_null_and_conflicts_for_runtime_validation(self):
        for options in [{"llm_config_id": "oauth-record"}, {"llm_config_id": None},
                        {"llm_config_id": "oauth-record", "provider": "api-record"}]:
            with self.subTest(options=options):
                result = _retry_payload({**options, "agent_id": "ignored", "message": "ignored"})
                self.assertTrue(result.pop("request_id"))
                self.assertEqual(result, options)

    def test_current_route_is_read_only_in_the_remote_allowlist(self):
        self.assertTrue(_route_allowed("GET", f"conversations/{self.CONVERSATION_ID}/run-config"))
        self.assertFalse(_route_allowed("PUT", f"conversations/{self.CONVERSATION_ID}/run-config"))
        self.assertFalse(_route_allowed("PUT", "settings/llm"))

    def _client(self, path):
        app = create_app(data_dir=path, dist_dir=path)
        store = app.state.device_store
        token, _ = store.exchange(store.issue_pairing_code(), "iPhone")
        return TestClient(app), {"Authorization": f"Bearer {token}"}

    def test_paired_http_reads_current_route_without_mutating_global_settings(self):
        route = {"llm_config_id": "oauth-record", "model_id": "same-model", "reasoning_effort": "xhigh"}
        path = f"/api/conversations/{self.CONVERSATION_ID}/run-config"
        with TemporaryDirectory() as directory, FakeRuntimeHttp({path: route}) as runtime, patch(
            "server.app.discover_upstream", return_value=runtime.upstream(),
        ):
            client, headers = self._client(Path(directory))
            self.assertEqual(client.get(path).status_code, 401)
            response = client.get(path, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), route)
            self.assertEqual(client.put(path, headers=headers, json=route).status_code, 403)

    def test_start_and_retry_both_carry_exact_oauth_identity_on_real_bridge(self):
        for retry in [False, True]:
            with self.subTest(retry=retry), TemporaryDirectory() as directory, FakeRuntimeSocket(
                lambda request_id: [command_result(request_id), *task_events(request_id, {
                    "type": "run_started", "task_id": "new-task",
                }), task_end(request_id)],
            ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
                client, headers = self._client(Path(directory))
                path = f"/remote/conversations/{self.CONVERSATION_ID}/tasks" + ("/old-task/retry" if retry else "")
                body = {"options": {"llm_config_id": "oauth-record", "model_id": "same-model", "reasoning_effort": "xhigh"}}
                if not retry:
                    body["message"] = "offline test"
                response = client.post(path, headers=headers, json=body)
                self.assertEqual(response.status_code, 200)
                command = runtime.commands[0]
                self.assertEqual(command["operation"], "rerun" if retry else "start")
                route = command["payload"] if retry else command["payload"]["options"]
                self.assertEqual(route["llm_config_id"], "oauth-record")
                self.assertNotIn("provider", route)
                if retry:
                    self.assertTrue(route["request_id"])
