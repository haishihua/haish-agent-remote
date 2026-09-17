"""The adapter reports the version it runs as: in the status payload and on the CLI."""

import io
import tomllib
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from server.app import ADAPTER_VERSION, create_app, main

REPO_ROOT = Path(__file__).resolve().parents[1]


class AdapterVersionTests(unittest.TestCase):
    def test_version_matches_the_pyproject_that_ships_it(self):
        declared = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
        self.assertEqual(ADAPTER_VERSION, declared)

    def test_remote_status_reports_the_version(self):
        with TemporaryDirectory() as directory:
            app = create_app(data_dir=Path(directory), dist_dir=Path(directory))
            payload = TestClient(app).get("/remote/status").json()
        self.assertEqual(payload["version"], ADAPTER_VERSION)

    def test_version_flag_prints_the_version(self):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["--version"])
        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(output.getvalue().strip(), f"haish-remote-adapter {ADAPTER_VERSION}")
