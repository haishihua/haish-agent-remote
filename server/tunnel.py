"""Publish this adapter through a supervised frpc.

The desktop client ships the frozen adapter next to the frpc binary and hands
the server settings over as environment variables. This module validates that
configuration, writes the frpc config into the adapter's data directory, and
keeps the tunnel process alive for as long as the adapter runs. The auth token
stays inside the 0600 config file and never enters logs or the status snapshot.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time

ENABLE_ENV = "HAISH_REMOTE_TUNNEL"
SERVER_ENV = "HAISH_REMOTE_TUNNEL_SERVER"
SERVER_PORT_ENV = "HAISH_REMOTE_TUNNEL_SERVER_PORT"
TOKEN_ENV = "HAISH_REMOTE_TUNNEL_TOKEN"
REMOTE_PORT_ENV = "HAISH_REMOTE_TUNNEL_REMOTE_PORT"
FRPC_ENV = "HAISH_REMOTE_FRPC"

DEFAULT_SERVER_PORT = 7000
RESTART_DELAYS_SECONDS = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)
HEALTHY_RUN_SECONDS = 60.0
PID_RECORD_NAME = "frpc.pid"

# Values land inside a TOML string; reject anything that could break out of it.
_UNSAFE_VALUE = re.compile(r"[\s\"'\\\x00-\x1f]")


class TunnelConfigError(RuntimeError):
    """The environment asked for a tunnel that cannot be configured."""


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _process_command(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    command = result.stdout.strip()
    return command or None


def disabled_snapshot() -> dict[str, object]:
    """The tunnel state of an adapter that was not asked to run one."""
    return {
        "enabled": False,
        "running": False,
        "pid": None,
        "server": None,
        "remote_port": None,
        "restarts": 0,
        "last_error": None,
    }


def _require_text(environ: Mapping[str, str], name: str) -> str:
    value = (environ.get(name) or "").strip()
    if not value:
        raise TunnelConfigError(f"{name} must be set when {ENABLE_ENV}=1.")
    if _UNSAFE_VALUE.search(value):
        raise TunnelConfigError(
            f"{name} contains whitespace, quotes, backslashes, or control characters.",
        )
    return value


def _require_port(environ: Mapping[str, str], name: str, *, default: int | None = None) -> int:
    raw = (environ.get(name) or "").strip()
    if not raw:
        if default is not None:
            return default
        raise TunnelConfigError(f"{name} must be set when {ENABLE_ENV}=1.")
    try:
        port = int(raw)
    except ValueError:
        raise TunnelConfigError(f"{name}={raw!r} is not a port number.") from None
    if not 1 <= port <= 65535:
        raise TunnelConfigError(f"{name}={raw!r} is outside 1-65535.")
    return port


@dataclass(frozen=True)
class TunnelSettings:
    """Everything frpc needs to publish this adapter."""

    server: str
    server_port: int
    token: str
    remote_port: int
    frpc_path: str
    local_port: int
    config_path: Path

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str],
        *,
        local_port: int,
        data_dir: Path,
    ) -> TunnelSettings | None:
        if (environ.get(ENABLE_ENV) or "").strip().lower() not in {"1", "true", "yes"}:
            return None
        server = _require_text(environ, SERVER_ENV)
        server_port = _require_port(environ, SERVER_PORT_ENV, default=DEFAULT_SERVER_PORT)
        token = _require_text(environ, TOKEN_ENV)
        remote_port = _require_port(environ, REMOTE_PORT_ENV)
        raw_frpc = (environ.get(FRPC_ENV) or "").strip()
        if not raw_frpc:
            raise TunnelConfigError(
                f"{FRPC_ENV} must point to the frpc binary that ships with the desktop client.",
            )
        frpc_path = Path(raw_frpc).expanduser()
        if not frpc_path.is_file():
            raise TunnelConfigError(f"{FRPC_ENV}={raw_frpc} is not a file.")
        if not os.access(frpc_path, os.X_OK):
            raise TunnelConfigError(f"{FRPC_ENV}={raw_frpc} is not executable.")
        return cls(
            server=server,
            server_port=server_port,
            token=token,
            remote_port=remote_port,
            frpc_path=str(frpc_path),
            local_port=local_port,
            config_path=Path(data_dir) / "frpc.toml",
        )

    @property
    def server_label(self) -> str:
        return f"{self.server}:{self.server_port}"

    def frpc_config(self) -> str:
        """The frpc config for this adapter.

        Mirrors the client config this project already runs against the public
        server; the proxy name is derived from the remote port so two computers
        sharing a server never register the same proxy.
        """
        return (
            f'serverAddr = "{self.server}"\n'
            f"serverPort = {self.server_port}\n"
            "\n"
            "[auth]\n"
            'method = "token"\n'
            f'token = "{self.token}"\n'
            "\n"
            "[[proxies]]\n"
            f'name = "haish-remote-{self.remote_port}"\n'
            'type = "tcp"\n'
            'localIP = "127.0.0.1"\n'
            f"localPort = {self.local_port}\n"
            f"remotePort = {self.remote_port}\n"
        )


class TunnelSupervisor:
    """Owns the frpc child: writes its config, restarts it, reports its state."""

    def __init__(
        self,
        settings: TunnelSettings,
        *,
        log: Callable[[str], None] | None = None,
        restart_delays: Sequence[float] = RESTART_DELAYS_SECONDS,
        healthy_run_seconds: float = HEALTHY_RUN_SECONDS,
    ) -> None:
        self._settings = settings
        self._log = log or (lambda line: print(line, flush=True))
        self._restart_delays = tuple(restart_delays)
        self._healthy_run_seconds = healthy_run_seconds
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        self._restarts = 0
        self._last_error: str | None = None

    def start(self) -> None:
        self._reap_stale_tunnel()
        self._write_config()
        self._thread = threading.Thread(target=self._supervise, name="haish-frpc", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        with self._lock:
            process = self._process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._thread is not None:
            self._thread.join(timeout=5)

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            process = self._process
            running = process is not None and process.poll() is None
            return {
                "enabled": True,
                "running": running,
                "pid": process.pid if running and process is not None else None,
                "server": self._settings.server_label,
                "remote_port": self._settings.remote_port,
                "restarts": self._restarts,
                "last_error": self._last_error,
            }

    @property
    def _pid_path(self) -> Path:
        return self._settings.config_path.parent / PID_RECORD_NAME

    def _write_pid_record(self, pid: int) -> None:
        try:
            self._pid_path.write_text(f"{pid}\n", encoding="utf-8")
        except OSError as error:
            self._log(f"[haish-frpc] could not write {self._pid_path}: {error}")

    def _remove_pid_record(self, pid: int) -> None:
        try:
            if self._pid_path.read_text(encoding="utf-8").strip() == str(pid):
                self._pid_path.unlink(missing_ok=True)
        except OSError:
            pass

    def _reap_stale_tunnel(self) -> None:
        """Stop a frpc left behind by an adapter that died without cleanup.

        The pid record is only trusted when the recorded pid still runs our own
        frpc (its command line names this adapter's config), so a reused pid is
        never killed.
        """
        try:
            pid = int(self._pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return
        if pid <= 0:
            return
        command = _process_command(pid)
        if command is None or str(self._settings.config_path) not in command:
            return
        self._log(f"[haish-frpc] stopping a tunnel left behind by a previous run (pid {pid})")
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return
        for _ in range(30):
            if not _process_alive(pid):
                return
            time.sleep(0.1)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

    def _write_config(self) -> None:
        path = self._settings.config_path
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(self._settings.frpc_config())
        finally:
            # O_CREAT does not tighten a file that already existed.
            os.chmod(path, 0o600)

    def _delay(self, restarts: int) -> float:
        index = min(max(restarts, 1) - 1, len(self._restart_delays) - 1)
        return self._restart_delays[index]

    def _record_failure(self, reason: str) -> None:
        with self._lock:
            self._restarts += 1
            self._last_error = reason
            restarts = self._restarts
        self._log(f"[haish-frpc] {reason}; restarting in {self._delay(restarts):.1f}s")

    def _supervise(self) -> None:
        while not self._stopping.is_set():
            started_at = time.monotonic()
            try:
                process = subprocess.Popen(
                    [self._settings.frpc_path, "-c", str(self._settings.config_path)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
            except OSError as error:
                self._record_failure(f"frpc failed to launch: {error}")
                self._stopping.wait(self._delay(self._restarts))
                continue
            with self._lock:
                self._process = process
            self._write_pid_record(process.pid)
            try:
                for line in process.stdout or ():
                    self._log(f"[haish-frpc] {line.rstrip()}")
                code = process.wait()
            finally:
                if process.stdout is not None:
                    process.stdout.close()
                with self._lock:
                    if self._process is process:
                        self._process = None
                self._remove_pid_record(process.pid)
            if self._stopping.is_set():
                return
            if time.monotonic() - started_at >= self._healthy_run_seconds:
                # A long, healthy run means the tunnel really works; failures
                # start counting from zero again.
                with self._lock:
                    self._restarts = 0
                    self._last_error = None
            self._record_failure(f"frpc exited with code {code}" if code else "frpc exited")
            self._stopping.wait(self._delay(self._restarts))
