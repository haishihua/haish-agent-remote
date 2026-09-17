"""The adapter owns its public tunnel: it supervises frpc and reports its state."""

import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest

from fastapi.testclient import TestClient

from server.app import create_app
from server.tunnel import (
    TunnelConfigError,
    TunnelSettings,
    TunnelSupervisor,
    disabled_snapshot,
)

ENABLED_ENV = {
    "HAISH_REMOTE_TUNNEL": "1",
    "HAISH_REMOTE_TUNNEL_SERVER": "203.0.113.9",
    "HAISH_REMOTE_TUNNEL_SERVER_PORT": "7000",
    "HAISH_REMOTE_TUNNEL_TOKEN": "unit-test-token",
    "HAISH_REMOTE_TUNNEL_REMOTE_PORT": "18766",
}


def write_frpc(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def write_standalone_frpc(directory: Path, name: str) -> Path:
    """A long-running single-process stand-in whose command line keeps `-c <config>`."""
    path = directory / name
    path.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(60)\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def wait_for(predicate, *, timeout=5.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if result or time.monotonic() >= deadline:
            return result
        time.sleep(interval)


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def kill_if_alive(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def wait_for_snapshot(supervisor, predicate, **kwargs):
    def check():
        snapshot = supervisor.snapshot()
        return snapshot if predicate(snapshot) else None

    return wait_for(check, **kwargs)


class TunnelSettingsTest(unittest.TestCase):
    def setUp(self):
        self._tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tempdir.cleanup)
        self.directory = Path(self._tempdir.name)
        self.frpc = write_frpc(self.directory, "frpc", "sleep 30")

    def _env(self, overrides=None):
        env = dict(ENABLED_ENV)
        env["HAISH_REMOTE_FRPC"] = str(self.frpc)
        env.update(overrides or {})
        return env

    def _settings(self, overrides=None):
        return TunnelSettings.from_env(
            self._env(overrides),
            local_port=8766,
            data_dir=self.directory / "data",
        )

    def test_no_tunnel_without_the_enable_flag(self):
        self.assertIsNone(TunnelSettings.from_env({}, local_port=8766, data_dir=self.directory))

    def test_reads_every_value_from_the_environment(self):
        settings = self._settings()
        self.assertEqual(settings.server, "203.0.113.9")
        self.assertEqual(settings.server_port, 7000)
        self.assertEqual(settings.remote_port, 18766)
        self.assertEqual(settings.local_port, 8766)
        self.assertEqual(settings.frpc_path, str(self.frpc))
        self.assertEqual(settings.server_label, "203.0.113.9:7000")
        self.assertEqual(settings.config_path, self.directory / "data" / "frpc.toml")

    def test_server_port_defaults_to_7000(self):
        env = self._env()
        env.pop("HAISH_REMOTE_TUNNEL_SERVER_PORT")
        settings = TunnelSettings.from_env(env, local_port=8766, data_dir=self.directory)
        self.assertEqual(settings.server_port, 7000)

    def test_a_missing_token_fails_loudly(self):
        with self.assertRaises(TunnelConfigError):
            self._settings({"HAISH_REMOTE_TUNNEL_TOKEN": ""})

    def test_a_missing_remote_port_fails_loudly(self):
        with self.assertRaises(TunnelConfigError):
            self._settings({"HAISH_REMOTE_TUNNEL_REMOTE_PORT": ""})

    def test_a_bad_port_fails_loudly(self):
        for value in ("0", "70000", "nope"):
            with self.subTest(value=value):
                with self.assertRaises(TunnelConfigError):
                    self._settings({"HAISH_REMOTE_TUNNEL_REMOTE_PORT": value})

    def test_a_missing_frpc_binary_fails_loudly(self):
        with self.assertRaises(TunnelConfigError):
            self._settings({"HAISH_REMOTE_FRPC": "/nonexistent/frpc"})

    def test_values_that_cannot_be_safely_written_to_toml_are_rejected(self):
        with self.assertRaises(TunnelConfigError):
            self._settings({"HAISH_REMOTE_TUNNEL_TOKEN": 'bad"token'})


class TunnelSupervisorTest(unittest.TestCase):
    def _supervisor(self, directory: Path, body: str, **kwargs) -> TunnelSupervisor:
        frpc = write_frpc(directory, "frpc", body)
        settings = TunnelSettings.from_env(
            {**ENABLED_ENV, "HAISH_REMOTE_FRPC": str(frpc)},
            local_port=8766,
            data_dir=directory,
        )
        return TunnelSupervisor(settings, log=lambda line: None, **kwargs)

    def test_start_writes_a_private_config_and_reports_the_running_tunnel(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            frpc = write_frpc(directory, "frpc", "sleep 30")
            settings = TunnelSettings.from_env(
                {**ENABLED_ENV, "HAISH_REMOTE_FRPC": str(frpc)},
                local_port=8766,
                data_dir=directory,
            )
            settings.config_path.write_text("stale\n", encoding="utf-8")
            os.chmod(settings.config_path, 0o644)
            supervisor = TunnelSupervisor(settings, log=lambda line: None)
            supervisor.start()
            try:
                config = settings.config_path.read_text(encoding="utf-8")
                self.assertIn('serverAddr = "203.0.113.9"', config)
                self.assertIn("serverPort = 7000", config)
                self.assertIn('token = "unit-test-token"', config)
                self.assertIn('name = "haish-remote-18766"', config)
                self.assertIn('localIP = "127.0.0.1"', config)
                self.assertIn("localPort = 8766", config)
                self.assertIn("remotePort = 18766", config)
                self.assertEqual(stat.S_IMODE(settings.config_path.stat().st_mode), 0o600)

                snapshot = wait_for_snapshot(supervisor, lambda s: s["running"])
                self.assertIsNotNone(snapshot)
                self.assertTrue(snapshot["enabled"])
                self.assertEqual(snapshot["server"], "203.0.113.9:7000")
                self.assertEqual(snapshot["remote_port"], 18766)
                self.assertEqual(snapshot["restarts"], 0)
                self.assertIsNone(snapshot["last_error"])
                self.assertTrue(process_alive(snapshot["pid"]))
                self.assertNotIn("unit-test-token", json.dumps(snapshot))
                pid_path = settings.config_path.parent / "frpc.pid"
                self.assertEqual(pid_path.read_text(encoding="utf-8").strip(), str(snapshot["pid"]))
            finally:
                supervisor.stop()
            self.assertFalse(supervisor.snapshot()["running"])
            self.assertIsNone(supervisor.snapshot()["pid"])
            self.assertFalse(pid_path.exists())

    def test_stop_terminates_the_tunnel_process(self):
        with tempfile.TemporaryDirectory() as raw:
            supervisor = self._supervisor(Path(raw), "sleep 30")
            supervisor.start()
            snapshot = wait_for_snapshot(supervisor, lambda s: s["running"])
            self.assertIsNotNone(snapshot)
            pid = snapshot["pid"]
            supervisor.stop()
            self.assertTrue(wait_for(lambda: not process_alive(pid)))

    def test_a_crashing_frpc_is_restarted_and_reported(self):
        with tempfile.TemporaryDirectory() as raw:
            supervisor = self._supervisor(
                Path(raw),
                'echo "start error: port already used" >&2\nexit 1',
                restart_delays=(0.05,),
            )
            supervisor.start()
            try:
                snapshot = wait_for_snapshot(
                    supervisor,
                    lambda s: s["restarts"] >= 2 and not s["running"],
                )
                self.assertIsNotNone(snapshot)
                self.assertGreaterEqual(snapshot["restarts"], 2)
                self.assertTrue(snapshot["enabled"])
                self.assertIn("exited with code 1", snapshot["last_error"] or "")
            finally:
                supervisor.stop()

    def test_stop_reaps_a_tunnel_that_spawned_children(self):
        # A helper that forks a child holds our output pipe open; stopping must
        # kill the whole process group instead of waiting out the join timeout.
        with tempfile.TemporaryDirectory() as raw:
            supervisor = self._supervisor(Path(raw), "sleep 30 &\nwait", restart_delays=(0.05,))
            supervisor.start()
            snapshot = wait_for_snapshot(supervisor, lambda s: s["running"])
            self.assertIsNotNone(snapshot)
            started = time.monotonic()
            supervisor.stop()
            self.assertLess(time.monotonic() - started, 5.0)
            self.assertFalse((Path(raw) / "frpc.pid").exists())
            with self.assertRaises(ProcessLookupError):
                os.killpg(snapshot["pid"], 0)

    def test_a_tunnel_left_behind_by_a_crashed_adapter_is_reaped(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            frpc = write_frpc(directory, "frpc", "sleep 30")
            settings = TunnelSettings.from_env(
                {**ENABLED_ENV, "HAISH_REMOTE_FRPC": str(frpc)},
                local_port=8766,
                data_dir=directory,
            )
            # An adapter killed with SIGKILL leaves its frpc and pid record behind;
            # start it detached so it is an orphan exactly like in production.
            stale_frpc = write_standalone_frpc(directory, "stale-frpc")
            helper = subprocess.run(
                [
                    "/bin/sh",
                    "-c",
                    f'"{stale_frpc}" -c "{settings.config_path}" >/dev/null 2>&1 & echo $!',
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            stale_pid = int(helper.stdout.strip())
            self.addCleanup(kill_if_alive, stale_pid)
            self.assertTrue(wait_for(lambda: process_alive(stale_pid)))
            (directory / "frpc.pid").write_text(f"{stale_pid}\n", encoding="utf-8")

            supervisor = TunnelSupervisor(settings, log=lambda line: None)
            supervisor.start()
            try:
                self.assertTrue(wait_for(lambda: not process_alive(stale_pid)))
                snapshot = wait_for_snapshot(supervisor, lambda s: s["running"])
                self.assertIsNotNone(snapshot)
                self.assertNotEqual(snapshot["pid"], stale_pid)
            finally:
                supervisor.stop()

    def test_a_reused_pid_is_not_killed(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            frpc = write_frpc(directory, "frpc", "sleep 30")
            settings = TunnelSettings.from_env(
                {**ENABLED_ENV, "HAISH_REMOTE_FRPC": str(frpc)},
                local_port=8766,
                data_dir=directory,
            )
            # A live process that is not our frpc (its command line lacks the config).
            bystander = subprocess.Popen(["/bin/sleep", "30"])
            self.addCleanup(lambda: (bystander.kill(), bystander.wait()))
            (directory / "frpc.pid").write_text(f"{bystander.pid}\n", encoding="utf-8")

            supervisor = TunnelSupervisor(settings, log=lambda line: None)
            supervisor.start()
            try:
                self.assertTrue(wait_for_snapshot(supervisor, lambda s: s["running"]) is not None)
                self.assertTrue(process_alive(bystander.pid))
            finally:
                supervisor.stop()

    def test_a_healthy_run_resets_the_failure_state(self):
        with tempfile.TemporaryDirectory() as raw:
            supervisor = self._supervisor(
                Path(raw),
                "exit 1",
                restart_delays=(0.05,),
                healthy_run_seconds=0.0,
            )
            supervisor.start()
            try:
                self.assertTrue(wait_for(lambda: supervisor.snapshot()["restarts"] >= 1))
                samples = [supervisor.snapshot()["restarts"] for _ in range(5)]
                self.assertLessEqual(max(samples), 1)
            finally:
                supervisor.stop()


class StatusEndpointTest(unittest.TestCase):
    def test_status_reports_a_disabled_tunnel_without_a_supervisor(self):
        with tempfile.TemporaryDirectory() as raw:
            app = create_app(data_dir=Path(raw), dist_dir=Path(raw))
            payload = TestClient(app).get("/remote/status").json()
        self.assertEqual(payload["tunnel"], disabled_snapshot())

    def test_status_reports_the_supervised_tunnel(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            frpc = write_frpc(directory, "frpc", "sleep 30")
            settings = TunnelSettings.from_env(
                {**ENABLED_ENV, "HAISH_REMOTE_FRPC": str(frpc)},
                local_port=8766,
                data_dir=directory,
            )
            supervisor = TunnelSupervisor(settings, log=lambda line: None)
            supervisor.start()
            try:
                self.assertTrue(wait_for(lambda: supervisor.snapshot()["running"]))
                app = create_app(data_dir=directory, dist_dir=directory)
                app.state.tunnel = supervisor
                payload = TestClient(app).get("/remote/status").json()
            finally:
                supervisor.stop()
        self.assertTrue(payload["tunnel"]["running"])
        self.assertEqual(payload["tunnel"]["remote_port"], 18766)
        self.assertIsNone(payload["tunnel"]["last_error"])
