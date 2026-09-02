from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from server.app import (
    DeviceStore,
    _computer_model,
    _pairing_uri,
    _public_endpoint,
    _remote_device_name,
    _route_allowed,
    create_app,
)


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
        self.assertFalse(_route_allowed("GET", "settings/memory"))
        self.assertFalse(_route_allowed("DELETE", "conversations/abc"))

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


if __name__ == "__main__":
    unittest.main()
