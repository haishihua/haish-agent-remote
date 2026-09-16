import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from websockets.exceptions import ConnectionClosedOK
from websockets.sync.server import serve as serve_runtime_socket

from server.app import (
    DeviceStore,
    RealtimeTaskStream,
    _attach_requested_providers,
    _computer_model,
    _compact_project_listing,
    _is_conversation_detail,
    _pairing_uri,
    _public_endpoint,
    _remote_device_name,
    _route_allowed,
    conversation_task_providers,
    create_app,
    realtime_events_url,
)


class FakeRuntimeHttp:
    """Minimal runtime HTTP server for the proxied GETs the adapter reshapes."""

    def __init__(self, payloads: dict[str, object]):
        self.payloads = payloads
        self.paths: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:  # noqa: N802 - http.server dispatch naming.
                outer.paths.append(self.path)
                payload = outer.payloads.get(self.path)
                body = json.dumps(payload if payload is not None else {"detail": "not found"}).encode()
                self.send_response(200 if payload is not None else 404)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "FakeRuntimeHttp":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def upstream(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"


class FakeRuntimeSocket:
    """Minimal runtime realtime socket that replays a scripted task stream.

    ``script`` receives the ``request_id`` of the command and returns the messages
    the runtime sends, in order, so tests spell out the real wire format: the
    ``command.result`` ack, then ``task.event`` frames, then ``task.end``.
    ``release_after`` stalls the fake before it sends the message at that index, which
    is how a test holds a run open while it pokes the adapter.
    """

    def __init__(self, script, *, release_after: int | None = None):
        self.commands: list[dict] = []
        self.script = script
        self.release_after = release_after
        self.release = threading.Event()
        self.completed = threading.Event()
        self.closed_cleanly = threading.Event()
        self.server = serve_runtime_socket(self._handle, "127.0.0.1", 0)
        self.port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "FakeRuntimeSocket":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.release.set()
        self.server.shutdown()
        self.thread.join(timeout=5)

    def upstream(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _handle(self, connection) -> None:
        command = json.loads(connection.recv())
        self.commands.append(command)
        try:
            for index, message in enumerate(self.script(command["request_id"])):
                if index == self.release_after:
                    self.release.wait(timeout=10)
                connection.send(json.dumps(message))
            self.completed.set()
            while True:
                # Stay alive until the adapter closes the socket, so an aborted
                # connection is visible as an exception instead of a clean close.
                connection.recv(timeout=5)
        except ConnectionClosedOK:
            self.closed_cleanly.set()
        except Exception:  # noqa: BLE001 - the test observes the close through the events.
            return


def command_result(request_id: str, *, ok: bool = True, **payload: object) -> dict:
    """The runtime answers every realtime command before it streams task events."""
    return {"type": "command.result", "request_id": request_id, "ok": ok, **payload}


def task_events(request_id: str, *events: dict) -> list[dict]:
    """``task.event`` frames wrapping scripted runtime events."""
    return [{"type": "task.event", "request_id": request_id, "event": event} for event in events]


def task_error(request_id: str, *, status: int, detail: object) -> dict:
    """The runtime failed the stream job itself."""
    return {"type": "task.error", "request_id": request_id, "status": status, "detail": detail}


def task_end(request_id: str) -> dict:
    """The runtime always closes a task stream with ``task.end``."""
    return {"type": "task.end", "request_id": request_id}


class RealtimeEventsUrlTest(unittest.TestCase):
    def test_realtime_events_url_follows_the_discovered_runtime(self):
        for upstream, expected in (
            ("http://127.0.0.1:54092", "ws://127.0.0.1:54092/api/events/ws"),
            ("https://runtime.example:8443", "wss://runtime.example:8443/api/events/ws"),
        ):
            with patch("server.app.discover_upstream", return_value=upstream):
                self.assertEqual(realtime_events_url(), expected)


class DeviceStoreTest(unittest.TestCase):
    @patch("server.app.subprocess.run")
    @patch("server.app.platform.system", return_value="Darwin")
    def test_computer_model_uses_macos_hardware_name(self, _system, run):
        run.return_value = Mock(stdout='{"SPHardwareDataType":[{"machine_name":"MacBook Air"}]}')
        self.assertEqual(_computer_model(), "MacBook Air")

    def test_pairing_code_is_one_time_and_device_can_be_revoked(self):
        with TemporaryDirectory() as directory:
            store = DeviceStore(Path(directory) / "remote.sqlite3")
            code = store.issue_pairing_code()
            first = store.exchange(code, "Phone")
            self.assertIsNotNone(first)
            self.assertIsNone(store.exchange(code, "Other phone"))
            token, device = first
            self.assertEqual(store.authenticate(token)["device_id"], device["device_id"])
            self.assertTrue(store.revoke(device["device_id"]))
            self.assertIsNone(store.authenticate(token))

    @patch.dict("server.app.os.environ", {"HAISH_REMOTE_PUBLIC_ENDPOINT": "https://47.97.24.242"})
    def test_public_endpoint_builds_the_versioned_pairing_uri(self):
        self.assertEqual(_public_endpoint(), "https://47.97.24.242")
        self.assertEqual(
            _pairing_uri("12345678"),
            "haish://pair?v=1&endpoint=https%3A%2F%2F47.97.24.242&code=12345678",
        )

    @patch.dict("server.app.os.environ", {"HAISH_REMOTE_PUBLIC_ENDPOINT": "http://47.97.24.242"})
    def test_public_endpoint_rejects_http(self):
        with self.assertRaisesRegex(RuntimeError, "secure HTTPS origin"):
            _public_endpoint()

    def test_remote_device_name_comes_from_request_headers(self):
        request = Mock(headers={"user-agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) Chrome/120"})
        self.assertEqual(_remote_device_name(request), "Pixel 7")
        request.headers = {"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile"}
        self.assertEqual(_remote_device_name(request), "iPhone")
        request.headers = {"sec-ch-ua-model": '"SM-S9280"', "user-agent": "Android"}
        self.assertEqual(_remote_device_name(request), "SM-S9280")

    def test_project_listing_keeps_only_lightweight_current_task_summaries(self):
        payload = {
            "projects": [{
                "project_id": "project-1",
                "conversations": [{
                    "conversation_id": "conversation-1",
                    "last_task_id": "task-3",
                    "tasks": [
                        {"task_id": "task-1", "status": "done", "error": "large historical output"},
                        {"task_id": "task-2", "status": "running", "stage": "working", "error": "large live output"},
                        {"task_id": "task-3", "status": "done", "completed_at": "2026-09-04T10:00:00Z", "model": "gpt"},
                    ],
                }],
            }],
        }

        compacted = _compact_project_listing(payload)
        tasks = compacted["projects"][0]["conversations"][0]["tasks"]
        self.assertEqual([task["task_id"] for task in tasks], ["task-2", "task-3"])
        self.assertEqual(tasks[0], {"task_id": "task-2", "status": "running", "stage": "working"})
        self.assertNotIn("model", tasks[1])
        self.assertNotIn("error", tasks[1])

    def test_project_listing_leaves_non_project_payload_unchanged(self):
        payload = {"detail": "upstream error"}
        self.assertIs(_compact_project_listing(payload), payload)

    def test_capacitor_origin_can_preflight_bearer_requests(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            client = TestClient(app)
            response = client.options(
                "/remote/status",
                headers={
                    "Origin": "capacitor://localhost",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "authorization",
                },
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["access-control-allow-origin"], "capacitor://localhost")
            self.assertIn("Authorization", response.headers["access-control-allow-headers"])

    def test_pairing_exchange_rejects_noncanonical_codes(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            client = TestClient(app)
            response = client.post("/remote/pairing/exchange", json={"code": "1234-5678"})
            self.assertEqual(response.status_code, 422)

    def test_loopback_desktop_can_list_and_revoke_paired_devices(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            store = app.state.device_store
            code = store.issue_pairing_code()
            _, device = store.exchange(code, "iPhone")
            client = TestClient(app)

            response = client.get("/remote/devices")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["devices"][0]["name"], "iPhone")

            response = client.delete(f"/remote/devices/{device['device_id']}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.get("/remote/devices").json(), {"devices": []})


class RemoteProxyTest(unittest.TestCase):
    def _client(self, directory: Path):
        app = create_app(data_dir=directory, dist_dir=directory)
        store = app.state.device_store
        token, _ = store.exchange(store.issue_pairing_code(), "iPhone")
        return TestClient(app), {"Authorization": f"Bearer {token}"}

    def test_remote_proxy_only_exposes_mobile_routes(self):
        self.assertTrue(_route_allowed("GET", "conversations"))
        self.assertTrue(_route_allowed("GET", "projects"))
        self.assertTrue(_route_allowed("GET", "agents"))
        self.assertTrue(_route_allowed("GET", "settings/llm"))
        self.assertTrue(_route_allowed("POST", "llm/models"))
        self.assertTrue(_route_allowed("POST", "messages/images"))
        self.assertTrue(_route_allowed("GET", "conversations/abc/messages/images/preview"))
        self.assertFalse(_route_allowed("POST", "projects"))
        self.assertTrue(_route_allowed("POST", "tasks/abc/cancel"))
        self.assertTrue(_route_allowed("GET", "approvals/state"))
        # Resolve routes live on the realtime socket inside the adapter now, so the
        # proxy must not expose them to a deleted runtime route.
        self.assertFalse(_route_allowed("POST", "approvals/abc/resolve"))
        self.assertFalse(_route_allowed("POST", "workflow-approvals/abc/resolve"))
        self.assertFalse(_route_allowed("POST", "user-inputs/abc/resolve"))
        self.assertFalse(_route_allowed("GET", "settings/memory"))
        self.assertFalse(_route_allowed("DELETE", "conversations/abc"))

    def test_stopped_runtime_is_reported_as_unavailable(self):
        with TemporaryDirectory() as directory:
            client, headers = self._client(Path(directory))
            with patch(
                "server.app.discover_upstream",
                side_effect=RuntimeError("Haish runtime was not found. Start the desktop app or set HAISH_UPSTREAM_URL."),
            ):
                response = client.get("/api/projects", headers=headers)

            self.assertEqual(response.status_code, 503)
            self.assertIn("runtime was not found", response.json()["detail"])


class RemoteTaskStartTest(unittest.TestCase):
    TASK_PATH = "/remote/conversations/conversation-1/tasks"
    TASK_BODY = {"message": "Ship it", "image_attachments": [], "options": {"execution_mode": "chat"}}

    def _client(self, directory: Path):
        app = create_app(data_dir=directory, dist_dir=directory)
        store = app.state.device_store
        code = store.issue_pairing_code()
        token, _ = store.exchange(code, "iPhone")
        return TestClient(app), {"Authorization": f"Bearer {token}"}

    def _start_task(self, client: TestClient, headers: dict):
        return client.post(self.TASK_PATH, json=self.TASK_BODY, headers=headers)

    def test_task_start_streams_runtime_events_as_ndjson(self):
        done_event = {
            "type": "run_finished",
            "task_id": "task-1",
            "payload": {"status": "done", "task": {"task_id": "task-1", "status": "done"}},
        }
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id),
                *task_events(request_id, {"type": "run_started", "task_id": "task-1"}, done_event),
                task_end(request_id),
            ],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "application/x-ndjson")
            events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            self.assertEqual([event["type"] for event in events], ["run_started", "run_finished"])
            self.assertEqual(events[-1]["payload"]["status"], "done")

            command = runtime.commands[0]
            self.assertEqual(command["type"], "task.start")
            self.assertEqual(command["operation"], "start")
            self.assertEqual(command["conversation_id"], "conversation-1")
            self.assertEqual(command["payload"]["message"], "Ship it")
            self.assertTrue(command["request_id"])

    def test_task_start_reports_runtime_rejections_with_their_status(self):
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id),
                task_error(request_id, status=409, detail="Conversation already has an active task."),
                task_end(request_id),
            ],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json(), {"detail": "Conversation already has an active task."})

    def test_task_start_reports_a_rejected_command_with_its_status(self):
        # The runtime answers task.start with a failing command.result when it never
        # schedules a stream job, so that rejection is all the phone can be told.
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id, ok=False, status=409, detail="request_id is already running."),
            ],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json(), {"detail": "request_id is already running."})

    def test_task_start_turns_a_non_failure_runtime_status_into_a_failure(self):
        # A success status around an error body would make the phone parse NDJSON
        # that never arrives instead of showing the runtime's failure.
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id, ok=False, status=200, detail="Bad command."),
            ],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 502)
            self.assertEqual(response.json(), {"detail": "Bad command."})

    def test_task_start_reports_a_stream_that_ended_before_its_first_event(self):
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [command_result(request_id), task_end(request_id)],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 502)
            self.assertIn("before it started", response.json()["detail"])

    def test_task_start_timeout_keeps_the_runtime_task_alive(self):
        # A slow start must not drop the runtime socket: the run may still be
        # starting, and the phone settles the turn on the persisted status.
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id),
                *task_events(request_id, {"type": "run_started", "task_id": "task-1"}),
                task_end(request_id),
            ],
            release_after=0,
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()), patch(
            "server.app.REALTIME_START_TIMEOUT_SECONDS",
            0.5,
        ):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 504)
            self.assertIn("did not answer", response.json()["detail"])
            self.assertFalse(runtime.closed_cleanly.is_set())

            runtime.release.set()
            self.assertTrue(runtime.closed_cleanly.wait(timeout=10))

    def test_mid_stream_runtime_failure_keeps_the_events_already_sent(self):
        # The phone keeps what it already received and reads the outcome from the
        # persisted task status, so the adapter ends the stream without inventing
        # a terminal event.
        with TemporaryDirectory() as directory, FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id),
                *task_events(request_id, {"type": "run_started", "task_id": "task-1"}),
                task_error(request_id, status=500, detail="Stream disconnected before completion."),
                task_end(request_id),
            ],
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            client, headers = self._client(Path(directory))
            response = self._start_task(client, headers)

            self.assertEqual(response.status_code, 200)
            events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            self.assertEqual([event["type"] for event in events], ["run_started"])

    def test_task_start_requires_a_paired_device(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            response = TestClient(app).post(
                self.TASK_PATH,
                json=self.TASK_BODY,
            )
            self.assertEqual(response.status_code, 401)

    async def _disconnect_after_first_event(self, runtime: FakeRuntimeSocket) -> str:
        """Be the phone: read one NDJSON line, then drop the connection mid-run."""
        stream = RealtimeTaskStream(conversation_id="conversation-1", payload=self.TASK_BODY)
        lines = stream.body_lines(await stream.open())
        line = await anext(lines)
        await lines.aclose()
        # Only now does the runtime finish, long after the phone left.
        runtime.release.set()
        await asyncio.wait_for(stream.worker, timeout=10)
        return line

    def test_phone_disconnect_keeps_draining_the_runtime_socket(self):
        # The runtime tears a run down when its own socket drops, so the adapter has
        # to keep draining the socket it owns until task.end, phone or no phone.
        with FakeRuntimeSocket(
            lambda request_id: [
                command_result(request_id),
                *task_events(
                    request_id,
                    {"type": "run_started", "task_id": "task-1"},
                    {"type": "run_finished", "payload": {"status": "done"}},
                ),
                task_end(request_id),
            ],
            release_after=2,
        ) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()):
            line = asyncio.run(self._disconnect_after_first_event(runtime))

            self.assertEqual(json.loads(line)["type"], "run_started")
            self.assertTrue(runtime.completed.wait(timeout=10))
            self.assertTrue(runtime.closed_cleanly.wait(timeout=10))


class RemoteApprovalResolveTest(unittest.TestCase):
    """The runtime deleted its HTTP resolve routes together with the NDJSON ones.

    The phone keeps its contract: the adapter turns each resolve call into an
    ``approval.resolve`` command on the realtime socket and reports the runtime's
    verdict back as HTTP, status and detail included.
    """

    def _client(self, directory: Path):
        app = create_app(data_dir=directory, dist_dir=directory)
        store = app.state.device_store
        token, _ = store.exchange(store.issue_pairing_code(), "iPhone")
        return TestClient(app), {"Authorization": f"Bearer {token}"}

    def _resolve(self, path: str, payload: dict, script):
        with TemporaryDirectory() as directory, FakeRuntimeSocket(script) as runtime, patch(
            "server.app.discover_upstream",
            return_value=runtime.upstream(),
        ):
            client, headers = self._client(Path(directory))
            response = client.post(path, json=payload, headers=headers)
        return response, runtime

    def test_tool_approval_resolve_uses_the_realtime_socket(self):
        response, runtime = self._resolve(
            "/api/approvals/approval-1/resolve",
            {"decision": "allow_once"},
            lambda request_id: [command_result(request_id, result={"ok": True})],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        command = runtime.commands[0]
        self.assertEqual(command["type"], "approval.resolve")
        self.assertEqual(command["approval_kind"], "tool")
        self.assertEqual(command["approval_id"], "approval-1")
        self.assertEqual(command["payload"], {"decision": "allow_once"})
        self.assertTrue(command["request_id"])

    def test_workflow_approval_resolve_keeps_the_decision_and_feedback(self):
        response, runtime = self._resolve(
            "/api/workflow-approvals/flow-1/resolve",
            {"decision": "reject", "feedback": "Too risky"},
            lambda request_id: [command_result(request_id, result={"ok": True})],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(runtime.commands[0]["approval_kind"], "workflow")
        self.assertEqual(runtime.commands[0]["payload"], {"decision": "reject", "feedback": "Too risky"})

    def test_user_input_resolve_keeps_the_answers(self):
        answers = [{"question_id": "question-1", "kind": "freeform", "text": "Ship it"}]
        response, runtime = self._resolve(
            "/api/user-inputs/input-1/resolve",
            {"answers": answers},
            lambda request_id: [command_result(request_id, result={"ok": True})],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(runtime.commands[0]["approval_kind"], "user_input")
        self.assertEqual(runtime.commands[0]["payload"], {"answers": answers})

    def test_resolve_reports_the_runtime_verdict_with_its_status(self):
        response, _ = self._resolve(
            "/api/approvals/approval-1/resolve",
            {"decision": "allow_once"},
            lambda request_id: [
                command_result(
                    request_id,
                    ok=False,
                    status=404,
                    detail="Approval request not found or already resolved.",
                ),
            ],
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Approval request not found or already resolved.")

    def test_resolve_reports_a_stopped_runtime(self):
        with TemporaryDirectory() as directory:
            client, headers = self._client(Path(directory))
            with patch(
                "server.app.discover_upstream",
                side_effect=RuntimeError("Haish runtime was not found. Start the desktop app or set HAISH_UPSTREAM_URL."),
            ):
                response = client.post(
                    "/api/approvals/approval-1/resolve",
                    json={"decision": "allow_once"},
                    headers=headers,
                )

            self.assertEqual(response.status_code, 503)
            self.assertIn("runtime was not found", response.json()["detail"])

    def test_resolve_times_out_when_the_runtime_stays_silent(self):
        with TemporaryDirectory() as directory, FakeRuntimeSocket(lambda _request_id: []) as runtime, patch(
            "server.app.discover_upstream",
            return_value=runtime.upstream(),
        ), patch("server.app.REALTIME_COMMAND_TIMEOUT_SECONDS", 0.5):
            client, headers = self._client(Path(directory))
            response = client.post(
                "/api/approvals/approval-1/resolve",
                json={"decision": "allow_once"},
                headers=headers,
            )

            self.assertEqual(response.status_code, 504)
            self.assertIn("did not answer", response.json()["detail"])

    def test_resolve_requires_a_paired_device(self):
        with TemporaryDirectory() as directory:
            client = TestClient(create_app(data_dir=Path(directory), dist_dir=Path(directory)))
            for path in (
                "/api/approvals/approval-1/resolve",
                "/api/workflow-approvals/flow-1/resolve",
                "/api/user-inputs/input-1/resolve",
            ):
                with self.subTest(path=path):
                    response = client.post(path, json={"decision": "allow_once"})
                    self.assertEqual(response.status_code, 401)


class ConversationRunConfigTest(unittest.TestCase):
    """The runtime records the client selector per task; the phone should read it."""

    CONVERSATION_ID = "af43484445be44a08f6d62bbe7ab486d"

    def _runtime_home(self, directory: Path, *, journal: list[dict] | None, snapshot: dict | None) -> Path:
        home = directory / "runtime"
        (home / "conversation_deltas").mkdir(parents=True)
        (home / "conversations").mkdir()
        if journal is not None:
            (home / "conversation_deltas" / f"{self.CONVERSATION_ID}.jsonl").write_text(
                "\n".join(json.dumps(entry) for entry in journal) + "\n",
                encoding="utf-8",
            )
        if snapshot is not None:
            (home / "conversations" / f"{self.CONVERSATION_ID}.json").write_text(
                json.dumps(snapshot), encoding="utf-8"
            )
        return home

    @staticmethod
    def _journal_entry(task_id: str, provider: str) -> dict:
        return {"id": "1", "v": 1, "task": {"task_id": task_id, "request_options": {"provider": provider}}}

    def test_provider_comes_from_the_journal_the_runtime_just_wrote(self):
        with TemporaryDirectory() as directory:
            home = self._runtime_home(
                Path(directory),
                journal=[self._journal_entry("task-1", "custom:opencode_go"), self._journal_entry("task-2", "llm-profile-router")],
                snapshot=None,
            )
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}):
                providers = conversation_task_providers(self.CONVERSATION_ID, last_task_id="task-2")
                enriched = _attach_requested_providers({
                    "conversation_id": self.CONVERSATION_ID,
                    "last_task_id": "task-2",
                    "tasks": [{"task_id": "task-1"}, {"task_id": "task-2"}, {"task_id": "task-9"}],
                })

            self.assertEqual(providers, {"task-1": "custom:opencode_go", "task-2": "llm-profile-router"})
            # The journal only carries the tasks the runtime just touched: the fast
            # path must leave everything else alone instead of guessing.
            self.assertEqual(
                [task.get("requested_provider") for task in enriched["tasks"]],
                ["custom:opencode_go", "llm-profile-router", None],
            )

    def test_pruned_journal_falls_back_to_the_conversation_snapshot(self):
        with TemporaryDirectory() as directory:
            home = self._runtime_home(
                Path(directory),
                journal=[self._journal_entry("task-1", "custom")],
                snapshot={"tasks": [
                    {"task_id": "task-1", "request_options": {"provider": "custom"}},
                    {"task_id": "task-2", "request_options": {"provider": "llm-profile-1783479743079"}},
                    {"task_id": "task-3"},
                ]},
            )
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}):
                providers = conversation_task_providers(self.CONVERSATION_ID, last_task_id="task-2")

            self.assertEqual(providers["task-2"], "llm-profile-1783479743079")

    def test_a_missing_store_is_not_an_error(self):
        with TemporaryDirectory() as directory:
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(Path(directory) / "absent")}):
                self.assertEqual(conversation_task_providers(self.CONVERSATION_ID), {})
                self.assertEqual(conversation_task_providers("../../etc/passwd"), {})

    def test_conversation_payload_carries_the_recorded_provider_per_task(self):
        with TemporaryDirectory() as directory:
            # The journal was pruned before the latest task, so the snapshot fills in
            # the tasks the journal lost while the journal still wins for the ones it kept.
            home = self._runtime_home(
                Path(directory),
                journal=[self._journal_entry("task-1", "custom:opencode_go")],
                snapshot={"tasks": [
                    {"task_id": "task-1", "request_options": {"provider": "llm-profile-1783479743079"}},
                    {"task_id": "task-2", "request_options": {"provider": "llm-profile-1783479743079"}},
                ]},
            )
            payload = {
                "conversation_id": self.CONVERSATION_ID,
                "last_task_id": "task-2",
                "tasks": [
                    {"task_id": "task-1", "provider_key": "custom", "model": "deepseek-v4-flash"},
                    {"task_id": "task-2", "provider_key": "custom", "model": "deepseek-v4-flash"},
                    {"task_id": "task-3", "provider_key": "custom", "requested_provider": "custom:opencode_go"},
                ],
            }
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}):
                enriched = _attach_requested_providers(payload)

            self.assertEqual(
                [task.get("requested_provider") for task in enriched["tasks"]],
                ["custom:opencode_go", "llm-profile-1783479743079", "custom:opencode_go"],
            )

    def test_a_runtime_that_reports_the_selector_itself_is_left_alone(self):
        with TemporaryDirectory() as directory:
            # The runtime hands the recorded selector over, so nothing should be read
            # from its state directory - not even when the file disagrees.
            home = self._runtime_home(
                Path(directory),
                journal=None,
                snapshot={"tasks": [{"task_id": "task-1", "request_options": {"provider": "from-the-file"}}]},
            )
            payload = {
                "conversation_id": self.CONVERSATION_ID,
                "last_task_id": "task-1",
                "tasks": [{
                    "task_id": "task-1",
                    "provider_key": "custom",
                    "model": "deepseek-v4-flash",
                    "request_provider": "llm-profile-1783479743079",
                    "request_model_id": "deepseek-v4-flash",
                }],
            }
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}):
                enriched = _attach_requested_providers(payload)

            self.assertIs(enriched, payload)
            self.assertNotIn("requested_provider", enriched["tasks"][0])

    def test_a_snapshot_past_the_size_cap_is_not_parsed(self):
        with TemporaryDirectory() as directory:
            home = self._runtime_home(
                Path(directory),
                journal=None,
                snapshot={"tasks": [{"task_id": "task-1", "request_options": {"provider": "llm-profile-router"}}]},
            )
            with patch.dict("server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}), patch(
                "server.app._MAX_SNAPSHOT_BYTES", 1
            ):
                self.assertEqual(conversation_task_providers(self.CONVERSATION_ID, last_task_id="task-1"), {})

    def test_only_the_conversation_detail_is_reshaped(self):
        self.assertTrue(_is_conversation_detail(f"conversations/{self.CONVERSATION_ID}"))
        self.assertFalse(_is_conversation_detail(f"conversations/{self.CONVERSATION_ID}/tasks"))
        self.assertFalse(_is_conversation_detail(f"conversations/{self.CONVERSATION_ID}/messages/images/preview"))
        self.assertFalse(_is_conversation_detail("conversations/"))
        self.assertFalse(_is_conversation_detail("projects"))

    def test_proxied_conversation_detail_exposes_the_selector(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            store = app.state.device_store
            token, _ = store.exchange(store.issue_pairing_code(), "iPhone")
            client = TestClient(app)
            headers = {"Authorization": f"Bearer {token}"}
            home = self._runtime_home(
                Path(directory),
                journal=[self._journal_entry("task-2", "llm-profile-1783479743079")],
                snapshot=None,
            )
            detail = {
                "conversation_id": self.CONVERSATION_ID,
                "last_task_id": "task-2",
                "tasks": [
                    {"task_id": "task-1", "provider_key": "custom", "model": "deepseek-v4-flash"},
                    {"task_id": "task-2", "provider_key": "custom", "model": "deepseek-v4-flash"},
                ],
            }
            task_list = [{"task_id": "task-2", "provider_key": "custom", "model": "deepseek-v4-flash"}]
            with FakeRuntimeHttp({
                f"/api/conversations/{self.CONVERSATION_ID}": detail,
                f"/api/conversations/{self.CONVERSATION_ID}/tasks": task_list,
            }) as runtime, patch("server.app.discover_upstream", return_value=runtime.upstream()), patch.dict(
                "server.app.os.environ", {"HAISH_RUNTIME_HOME": str(home)}
            ):
                response = client.get(f"/api/conversations/{self.CONVERSATION_ID}", headers=headers)
                untouched = client.get(f"/api/conversations/{self.CONVERSATION_ID}/tasks", headers=headers)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                [task.get("requested_provider") for task in response.json()["tasks"]],
                [None, "llm-profile-1783479743079"],
            )
            self.assertEqual(untouched.status_code, 200)
            self.assertNotIn("requested_provider", untouched.json()[0])


if __name__ == "__main__":
    unittest.main()
