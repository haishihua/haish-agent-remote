from __future__ import annotations

import argparse
import asyncio
import atexit
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, contextmanager
import hashlib
from importlib.metadata import PackageNotFoundError, version as _distribution_version
import json
import os
import platform
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import time
import tomllib
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator
import uvicorn
import websockets

from server.desktop import DesktopManager, ice_servers
from server.desktop_management import create_management_app

from server.tunnel import (
    TunnelConfigError,
    TunnelSettings,
    TunnelSupervisor,
    disabled_snapshot,
)


COOKIE_NAME = "haish_remote_device"
PAIRING_TTL_SECONDS = 5 * 60
DEFAULT_DATA_DIR = Path(os.getenv("HAISH_REMOTE_DATA_DIR", "~/.haish-remote")).expanduser()
DEFAULT_DIST_DIR = Path(__file__).resolve().parents[1] / "dist"


def _adapter_version() -> str:
    """The version this adapter runs as.

    Frozen releases carry the distribution metadata copied in at build time; a
    source checkout falls back to the pyproject it was cloned with.
    """
    try:
        return _distribution_version("haish-agent-remote")
    except PackageNotFoundError:
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        if pyproject.is_file():
            return tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
        raise RuntimeError(
            "Cannot determine the adapter version: the distribution metadata is "
            "missing and no pyproject.toml sits next to this build.",
        ) from None


ADAPTER_VERSION = _adapter_version()

# The runtime owns task streams, approval events and every resolve command on its
# realtime WebSocket. The legacy NDJSON task endpoints and the HTTP resolve routes
# are gone, so the adapter bridges that socket to the mobile contract instead of
# proxying an HTTP route.
REALTIME_EVENTS_PATH = "/api/events/ws"
REALTIME_ORIGIN = "haish://app"
REALTIME_START_TIMEOUT_SECONDS = 20.0
REALTIME_COMMAND_TIMEOUT_SECONDS = 15.0
NDJSON_HEADERS = {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
}

_ALLOWED_CORE_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (method, re.compile(pattern))
    for method, pattern in (
        ("GET", r"conversations"),
        ("POST", r"conversations"),
        # 第一条消息把占位名换成一句话摘要：桌面同样在客户端侧 PATCH（core 的
        # `update_conversation`），所以这条路由和 GET 一样只是转发给 runtime。
        ("PATCH", r"conversations/[^/]+"),
        ("GET", r"projects"),
        ("GET", r"agents"),
        # Remote clients may read the provider catalog to build per-task options,
        # but must never mutate the desktop's global LLM settings.
        ("GET", r"settings/llm"),
        ("POST", r"llm/models"),
        ("POST", r"messages/images"),
        ("GET", r"conversations/[^/]+"),
        ("GET", r"conversations/[^/]+/messages/images/preview"),
        ("GET", r"conversations/[^/]+/tasks"),
        ("GET", r"tasks/[^/]+"),
        ("GET", r"tasks/[^/]+/events"),
        ("POST", r"tasks/[^/]+/cancel"),
        ("POST", r"tasks/[^/]+/inputs"),
        ("POST", r"conversations/[^/]+/tasks/cancel"),
        ("GET", r"approvals/state"),
        # Tool, workflow and user-input approvals resolve over the realtime socket
        # inside the adapter, so they must not be proxied to deleted HTTP routes.
    )
)

_ACTIVE_TASK_STATUSES = {"queued", "running"}
_MODEL_CATALOG_TASK_FIELDS = (
    "provider",
    "provider_key",
    "model",
    "request_provider",
    "requested_provider",
    "provider_selector",
    "request_model_id",
    "request_options",
)
_PROJECT_LIST_TASK_FIELDS = (
    # Current-task request previews let unopened desktop conversations notify correctly.
    "title",
    "display_text",
    "task_id",
    "conversation_id",
    "status",
    "stage",
    "created_at",
    "updated_at",
    "completed_at",
    # Preserve the provider/model tuple on current task summaries so an initially rendered
    # conversation can restore its run config without waiting for the detail request.
    *_MODEL_CATALOG_TASK_FIELDS,
)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _public_endpoint() -> str:
    value = os.getenv("HAISH_REMOTE_PUBLIC_ENDPOINT", "").strip()
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("HAISH_REMOTE_PUBLIC_ENDPOINT must be a secure HTTPS origin.") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("HAISH_REMOTE_PUBLIC_ENDPOINT must be a secure HTTPS origin.")
    return f"https://{parsed.netloc}"


def _pairing_uri(code: str) -> str:
    return f"haish://pair?{urlencode({'v': '1', 'endpoint': _public_endpoint(), 'code': code})}"


def _computer_model() -> str:
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["system_profiler", "SPHardwareDataType", "-json"],
                capture_output=True,
                check=True,
                text=True,
                timeout=3,
            )
            hardware = json.loads(result.stdout).get("SPHardwareDataType", [])
            if hardware and hardware[0].get("machine_name"):
                return str(hardware[0]["machine_name"])
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
    return platform.node() or platform.machine() or "Computer"


class DeviceStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS pairing_codes (
                    code_hash TEXT PRIMARY KEY,
                    expires_at REAL NOT NULL,
                    used_at REAL
                );
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    token_hash TEXT UNIQUE NOT NULL,
                    created_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    revoked_at REAL
                );
                CREATE TABLE IF NOT EXISTS conversation_reads (
                    conversation_id TEXT PRIMARY KEY,
                    seen_at_ms INTEGER NOT NULL,
                    updated_by TEXT NOT NULL
                );
                """
            )

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def issue_pairing_code(self) -> str:
        code = f"{secrets.randbelow(100_000_000):08d}"
        now = time.time()
        with self._connect() as db:
            db.execute("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL", (now,))
            db.execute(
                "INSERT INTO pairing_codes(code_hash, expires_at) VALUES (?, ?)",
                (_digest(code), now + PAIRING_TTL_SECONDS),
            )
        return code

    def exchange(self, code: str, name: str) -> tuple[str, dict[str, Any]] | None:
        now = time.time()
        code_hash = _digest(code)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            record = db.execute(
                "SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?",
                (code_hash, now),
            ).fetchone()
            if record is None:
                db.rollback()
                return None
            db.execute("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?", (now, code_hash))
            token = secrets.token_urlsafe(32)
            device = {
                "device_id": uuid4().hex,
                "name": name[:80],
                "created_at": now,
                "last_seen_at": now,
            }
            db.execute(
                "INSERT INTO devices(device_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
                (device["device_id"], device["name"], _digest(token), now, now),
            )
            db.commit()
            return token, device

    def authenticate(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        now = time.time()
        with self._connect() as db:
            row = db.execute(
                "SELECT device_id, name, created_at, last_seen_at FROM devices "
                "WHERE token_hash = ? AND revoked_at IS NULL",
                (_digest(token),),
            ).fetchone()
            if row is None:
                return None
            db.execute("UPDATE devices SET last_seen_at = ? WHERE device_id = ?", (now, row["device_id"]))
        return dict(row)

    def list_devices(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT device_id, name, created_at, last_seen_at FROM devices "
                "WHERE revoked_at IS NULL ORDER BY last_seen_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def revoke(self, device_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                "UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
                (time.time(), device_id),
            )
        return cursor.rowcount > 0

    def conversation_reads(self) -> dict[str, int]:
        with self._connect() as db:
            rows = db.execute("SELECT conversation_id, seen_at_ms FROM conversation_reads").fetchall()
        return {str(row["conversation_id"]): int(row["seen_at_ms"]) for row in rows}

    def mark_conversation_read(self, conversation_id: str, seen_at_ms: int, updated_by: str) -> int:
        # Read cursors are monotonic. A delayed request from either client must never make a
        # conversation unread again after the other client already acknowledged a newer result.
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO conversation_reads(conversation_id, seen_at_ms, updated_by)
                VALUES (?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    seen_at_ms = max(conversation_reads.seen_at_ms, excluded.seen_at_ms),
                    updated_by = CASE
                        WHEN excluded.seen_at_ms >= conversation_reads.seen_at_ms THEN excluded.updated_by
                        ELSE conversation_reads.updated_by
                    END
                """,
                (conversation_id, seen_at_ms, updated_by),
            )
            row = db.execute(
                "SELECT seen_at_ms FROM conversation_reads WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["seen_at_ms"])


class PairingRequest(BaseModel):
    code: str = Field(pattern=r"^\d{8}$")


class ConversationReadRequest(BaseModel):
    seen_at_ms: int = Field(gt=0, le=9_007_199_254_740_991)


def _remote_device_name(request: Request) -> str:
    model = request.headers.get("sec-ch-ua-model", "").strip().strip('"')
    if model:
        return model[:80]
    user_agent = request.headers.get("user-agent", "")
    if "iPhone" in user_agent:
        return "iPhone"
    if "iPad" in user_agent or ("Macintosh" in user_agent and "Mobile" in user_agent):
        return "iPad"
    if "Android" in user_agent:
        match = re.search(r"Android[^;)]*;\s*([^;)]+?)(?:\s+Build/[^;)]+)?[;)]", user_agent)
        android_model = match.group(1).strip() if match else ""
        return android_model[:80] if android_model and android_model != "K" else "Android device"
    if "Windows" in user_agent:
        return "Windows PC"
    if "Macintosh" in user_agent:
        return "Mac"
    if "Linux" in user_agent:
        return "Linux device"
    return "Web device"


class TaskStartRequest(BaseModel):
    # message 允许为空：只带引用（或者只带图）也是一轮——runtime 的 TaskStreamRequest.message
    # 就是默认空串，被选中的那段原文本身就是这轮要说的话。两样都没有才是客户端出了错。
    message: str = Field(default='', max_length=20_000)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    image_attachments: list[dict[str, Any]] = Field(default_factory=list)
    # 引用批注（桌面的「添加注释」）：手机只负责把用户选中的那段话原样带过来，
    # 字段语义与上限（20 条、来源必须是本会话已完成的回答）由 runtime 校验，
    # 适配器不复制那套规则——复制一份就会和 runtime 漂移。
    annotations: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    options: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode='after')
    def _require_a_payload(self) -> 'TaskStartRequest':
        if not self.message.strip() and not self.annotations and not self.image_attachments:
            raise ValueError('A message, an image or at least one quoted comment is required.')
        return self


def _candidate_pid_files() -> list[Path]:
    explicit = os.getenv("HAISH_RUNTIME_PID_FILE")
    if explicit:
        return [Path(explicit).expanduser()]
    support = Path.home() / "Library" / "Application Support"
    candidates = list(support.glob("Haish*/runtime/runtime.pid"))
    linux = Path.home() / ".config"
    candidates.extend(linux.glob("Haish*/runtime/runtime.pid"))
    return sorted(candidates, key=lambda path: path.stat().st_mtime if path.exists() else 0, reverse=True)


def discover_upstream() -> str:
    explicit = os.getenv("HAISH_UPSTREAM_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    for path in _candidate_pid_files():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            port = int(payload["port"])
            if 1 <= port <= 65535:
                return f"http://127.0.0.1:{port}"
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            continue
    raise RuntimeError("Haish runtime was not found. Start the desktop app or set HAISH_UPSTREAM_URL.")


# Every task stores the options its client sent (`request_options.provider`), but the
# runtime API only exposes the coarse `provider_key`: two saved custom providers that
# share a model (`custom` + `deepseek-v4-flash`) stay indistinguishable, so a phone
# that never started the task would keep falling back to the first matching entry.
# The runtime persists those options in its own state directory, next to the pid file
# the adapter already discovers; read them from there instead of guessing.
_RUNTIME_TASK_PROVIDER_CACHE: dict[tuple[str, int, int], dict[str, str]] = {}
_SAFE_CONVERSATION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# A conversation record this large costs hundreds of megabytes to parse; past this
# point the phone keeps its own fallback ordering instead of stalling the adapter.
_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024


def runtime_home() -> Path | None:
    """State directory of the runtime this adapter proxies to."""
    explicit = os.getenv("HAISH_RUNTIME_HOME", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    for path in _candidate_pid_files():
        if path.is_file():
            return path.parent
    return None


def _recorded_provider(task: Any) -> str:
    options = task.get("request_options") if isinstance(task, dict) else None
    if not isinstance(options, dict):
        return ""
    return str(options.get("provider") or "").strip()


def _task_providers_from_journal(path: Path) -> dict[str, str]:
    """Realtime delta journal: one task record per line, newest last."""
    providers: dict[str, str] = {}
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                task = record.get("task") if isinstance(record, dict) else None
                task_id = str(task.get("task_id") or "") if isinstance(task, dict) else ""
                provider = _recorded_provider(task)
                if task_id and provider:
                    providers[task_id] = provider
    except OSError:
        return {}
    return providers


def _task_providers_from_snapshot(path: Path) -> dict[str, str]:
    """Persisted conversation state: megabytes, parsed once per change and cached."""
    try:
        stat = path.stat()
    except OSError:
        return {}
    if stat.st_size > _MAX_SNAPSHOT_BYTES:
        return {}
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _RUNTIME_TASK_PROVIDER_CACHE.get(cache_key)
    if cached is not None:
        return cached
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    tasks = payload.get("tasks") if isinstance(payload, dict) else None
    providers: dict[str, str] = {}
    for task in tasks if isinstance(tasks, list) else []:
        task_id = str(task.get("task_id") or "") if isinstance(task, dict) else ""
        provider = _recorded_provider(task)
        if task_id and provider:
            providers[task_id] = provider
    _RUNTIME_TASK_PROVIDER_CACHE.clear()
    _RUNTIME_TASK_PROVIDER_CACHE[cache_key] = providers
    return providers


def conversation_task_providers(conversation_id: str, *, last_task_id: str = "") -> dict[str, str]:
    """Provider selector per task id, as recorded by the runtime for this conversation.

    The journal is small and covers whatever the runtime just touched, which is the
    case that matters right now; the full snapshot is the fallback for conversations
    whose journal has already been pruned.
    """
    home = runtime_home()
    if home is None or not _SAFE_CONVERSATION_ID.fullmatch(conversation_id):
        return {}
    journal = _task_providers_from_journal(home / "conversation_deltas" / f"{conversation_id}.jsonl")
    if last_task_id and journal.get(last_task_id):
        return journal
    snapshot = _task_providers_from_snapshot(home / "conversations" / f"{conversation_id}.json")
    if not snapshot:
        return journal
    snapshot.update(journal)
    return snapshot


def _token_from_request(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(COOKIE_NAME)


def _is_loopback(request: Request) -> bool:
    return bool(request.client and request.client.host in {"127.0.0.1", "::1", "localhost", "testclient"})


def _route_allowed(method: str, path: str) -> bool:
    return any(method == allowed_method and pattern.fullmatch(path) for allowed_method, pattern in _ALLOWED_CORE_ROUTES)


def realtime_events_url() -> str:
    """Realtime WebSocket URL of the discovered runtime (it shares the HTTP port)."""
    parsed = urlsplit(discover_upstream())
    scheme = "wss" if parsed.scheme == "https" else "ws"
    # Keep whatever base path the runtime is configured behind, exactly like the
    # HTTP proxy does, so both transports address the same runtime.
    return f"{scheme}://{parsed.netloc}{parsed.path.rstrip('/')}{REALTIME_EVENTS_PATH}"


def _realtime_error_detail(value: Any) -> Any:
    """Keep the runtime's error body shape so the phone can read it verbatim."""
    if isinstance(value, (str, list, dict)) and value:
        return value
    return "The Haish runtime rejected the request."


def _realtime_status(value: Any) -> int:
    """Pass the runtime's failure status through; anything else is a broken runtime.

    Only 4xx/5xx may reach the phone as the status of this response: a success
    status wrapped around an error body would make the phone read NDJSON that
    is not there instead of showing the runtime's failure.
    """
    try:
        status = int(value)
    except (TypeError, ValueError):
        return 502
    return status if 400 <= status <= 599 else 502


class TaskStreamError(Exception):
    """The runtime rejected a realtime command before it could produce a result."""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


async def run_realtime_command(command: dict[str, Any]) -> Any:
    """Run one command on the runtime realtime socket and return its ``result``.

    The runtime deleted the HTTP resolve routes together with the task NDJSON
    endpoints, so approvals keep their phone contract by travelling as
    ``approval.resolve`` over the same socket task streams use. Broadcasts and
    other requesters' frames are skipped by ``request_id``, exactly like the task
    bridge skips them.
    """
    request_id = str(command.get("request_id") or "")
    try:
        url = realtime_events_url()
    except RuntimeError as error:
        # The runtime is stopped or restarting: report it like the HTTP proxy does.
        raise TaskStreamError(503, str(error)) from error
    try:
        async with websockets.connect(
            url,
            origin=REALTIME_ORIGIN,
            proxy=None,
            open_timeout=REALTIME_COMMAND_TIMEOUT_SECONDS,
            close_timeout=2.0,
            max_size=None,
        ) as socket:
            await socket.send(json.dumps(command, ensure_ascii=False))
            while True:
                raw = await asyncio.wait_for(socket.recv(), timeout=REALTIME_COMMAND_TIMEOUT_SECONDS)
                message = json.loads(raw)
                if not isinstance(message, dict) or str(message.get("request_id") or "") != request_id:
                    continue
                kind = str(message.get("type") or "")
                if kind == "command.result":
                    if message.get("ok") is False:
                        raise TaskStreamError(_realtime_status(message.get("status")), _realtime_error_detail(message.get("detail")))
                    return message.get("result")
                if kind == "task.error":
                    raise TaskStreamError(_realtime_status(message.get("status")), _realtime_error_detail(message.get("detail")))
    except TaskStreamError:
        raise
    except asyncio.TimeoutError as error:
        raise TaskStreamError(504, "The Haish runtime did not answer the request.") from error
    except Exception as error:  # noqa: BLE001 - the transport boundary reports producer failures.
        raise TaskStreamError(502, f"Runtime realtime stream failed: {error}") from error


async def _resolve_realtime_approval(request: Request, *, approval_id: str, approval_kind: str) -> JSONResponse:
    """Keep the phone's HTTP resolve contract while the runtime answers on the socket."""
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = None
    if not isinstance(payload, dict):
        return JSONResponse(content={"detail": "Request body must be a JSON object."}, status_code=400)
    command = {
        "type": "approval.resolve",
        "request_id": uuid4().hex,
        "approval_id": approval_id,
        "approval_kind": approval_kind,
        "payload": payload,
    }
    try:
        await run_realtime_command(command)
    except TaskStreamError as error:
        return JSONResponse(content={"detail": error.detail}, status_code=error.status)
    return JSONResponse(content={"ok": True})


class RealtimeTaskStream:
    """Bridge a runtime realtime task stream to the mobile NDJSON contract.

    The runtime keeps the run inside the realtime socket: a dropped socket tears the
    run down. The adapter therefore owns the socket and keeps draining it until the
    runtime reports ``task.end``, even when the phone disconnects, so the run always
    reaches its persisted ``done`` / ``failed`` / ``cancelled`` status. The phone
    reads whatever events it is still connected for and polls that status afterwards.
    """

    def __init__(self, *, conversation_id: str, payload: dict[str, Any]) -> None:
        self.conversation_id = conversation_id
        self.payload = payload
        self.request_id = uuid4().hex
        self.messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.forwarding = True
        self.worker: asyncio.Task[None] | None = None

    @property
    def command(self) -> dict[str, Any]:
        return {
            "type": "task.start",
            "request_id": self.request_id,
            "operation": "start",
            "conversation_id": self.conversation_id,
            "payload": self.payload,
        }

    async def open(self) -> dict[str, Any]:
        """Return the first runtime event, or raise ``TaskStreamError`` for a start failure."""
        self.worker = asyncio.create_task(self._pump())
        try:
            first = await asyncio.wait_for(self.messages.get(), timeout=REALTIME_START_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            # Stop forwarding but keep the socket: the runtime may still be starting
            # the run, and a terminal status is what the phone needs in the end.
            self.forwarding = False
            raise TaskStreamError(504, "The Haish runtime did not answer the task stream.") from error
        if first["kind"] == "event":
            return first
        # A rejected command, or a stream that ended before its first event, never
        # started a run, so the socket has nothing left to drain for the phone.
        await self.abandon()
        if first["kind"] == "error":
            raise TaskStreamError(first["status"], first["detail"])
        raise TaskStreamError(502, "The Haish runtime ended the task stream before it started.")

    async def body_lines(self, first: dict[str, Any]) -> AsyncIterator[str]:
        """Yield NDJSON event lines for the phone until the runtime ends the stream."""
        try:
            item = first
            while item["kind"] == "event":
                yield json.dumps(item["event"], ensure_ascii=False) + "\n"
                item = await self.messages.get()
        finally:
            # The phone is gone or the stream is over. A mid-stream failure ends the
            # response without inventing a terminal event: the phone polls the task
            # status the runtime persisted for it.
            self.forwarding = False

    async def abandon(self) -> None:
        """Drop the bridge when the runtime is not going to stream this task."""
        self.forwarding = False
        if self.worker is not None:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)

    async def _emit(self, item: dict[str, Any]) -> None:
        if self.forwarding:
            await self.messages.put(item)

    def _error_item(self, message: dict[str, Any]) -> dict[str, Any]:
        """Runtime failures keep their status and body shape for the phone."""
        return {
            "kind": "error",
            "status": _realtime_status(message.get("status")),
            "detail": _realtime_error_detail(message.get("detail")),
        }

    def _owns(self, message: dict[str, Any]) -> bool:
        return str(message.get("request_id") or "") == self.request_id

    async def _pump(self) -> None:
        try:
            async with websockets.connect(
                realtime_events_url(),
                origin=REALTIME_ORIGIN,
                proxy=None,
                open_timeout=REALTIME_START_TIMEOUT_SECONDS,
                close_timeout=2.0,
                max_size=None,
            ) as socket:
                await socket.send(json.dumps(self.command))
                async for raw in socket:
                    message = json.loads(raw)
                    if not isinstance(message, dict) or not self._owns(message):
                        # Approval broadcasts carry no request_id and belong to the
                        # phone's HTTP polling, not to this task stream.
                        continue
                    kind = str(message.get("type") or "")
                    if kind == "task.event":
                        await self._emit({"kind": "event", "event": message.get("event")})
                        continue
                    if kind == "command.result" and message.get("ok") is False:
                        # The runtime acks task.start before streaming; a rejected
                        # command carries the same status/detail the phone renders.
                        await self._emit(self._error_item(message))
                        return
                    if kind == "task.error":
                        await self._emit(self._error_item(message))
                        return
                    if kind == "task.end":
                        return
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - the transport boundary reports producer failures.
            await self._emit({
                "kind": "error",
                "status": 502,
                "detail": f"Runtime realtime stream failed: {error}",
            })
        finally:
            await self._emit({"kind": "end"})


def _carried_selector(task: Any) -> str:
    """The recorded selector a task already carries, from either runtime or adapter."""
    if not isinstance(task, dict):
        return ""
    options = task.get("request_options")
    return str(
        task.get("request_provider")
        or task.get("requested_provider")
        or (options.get("provider") if isinstance(options, dict) else "")
        or ""
    ).strip()


def _attach_requested_providers(payload: Any) -> Any:
    """Carry the provider each task ran with onto the conversation payload.

    The phone restores a conversation's run config from its latest task, and
    `provider_key` alone cannot tell two saved custom providers apart. A runtime that
    exposes the recorded selector itself (`request_provider`) is left untouched.
    """
    if not isinstance(payload, dict):
        return payload
    conversation_id = str(payload.get("conversation_id") or "")
    tasks = payload.get("tasks")
    if not conversation_id or not isinstance(tasks, list) or not tasks:
        return payload
    newest = next(
        (task for task in tasks if isinstance(task, dict) and task.get("task_id") == payload.get("last_task_id")),
        tasks[-1],
    )
    if _carried_selector(newest):
        return payload
    providers = conversation_task_providers(conversation_id, last_task_id=str(payload.get("last_task_id") or ""))
    if not providers:
        return payload
    for task in tasks:
        if not isinstance(task, dict) or task.get("requested_provider"):
            continue
        provider = providers.get(str(task.get("task_id") or ""))
        if provider:
            task["requested_provider"] = provider
    return payload


def _is_conversation_detail(path: str) -> bool:
    """`conversations/<id>` only: the task and image sub-routes stay untouched."""
    prefix = "conversations/"
    return path.startswith(prefix) and bool(path[len(prefix):]) and "/" not in path[len(prefix):]


def _compact_project_listing(payload: Any) -> Any:
    """Keep directory polling lightweight; conversation detail is fetched on demand."""
    if not isinstance(payload, dict) or not isinstance(payload.get("projects"), list):
        return payload
    model_catalog_tasks: list[dict[str, Any]] = []
    seen_catalog_rows: set[str] = set()
    for project in payload["projects"]:
        if not isinstance(project, dict) or not isinstance(project.get("conversations"), list):
            continue
        for conversation in project["conversations"]:
            if not isinstance(conversation, dict):
                continue
            last_task_id = conversation.get("last_task_id")
            tasks = conversation.get("tasks") if isinstance(conversation.get("tasks"), list) else []
            # Keep one tiny row for every provider/model combination seen in durable history. This
            # lets the phone recover the real catalog when an OAuth refresh is temporarily 401,
            # without retaining historical event logs or outputs in the directory response.
            for task in tasks:
                if not isinstance(task, dict):
                    continue
                row = {field: task[field] for field in _MODEL_CATALOG_TASK_FIELDS if field in task}
                model = str(row.get("request_model_id") or row.get("model") or "").strip()
                options = row.get("request_options")
                if not model and isinstance(options, dict):
                    model = str(options.get("model_id") or "").strip()
                if not model:
                    continue
                key = json.dumps([
                    row.get("provider"),
                    row.get("provider_key"),
                    _carried_selector(row),
                    model,
                ], default=str)
                if key not in seen_catalog_rows:
                    seen_catalog_rows.add(key)
                    model_catalog_tasks.append(row)
            conversation["tasks"] = [
                {
                    field: (task[field][:512] if field in {"title", "display_text"} and isinstance(task[field], str) else task[field])
                    for field in _PROJECT_LIST_TASK_FIELDS if field in task
                }
                for task in tasks
                if isinstance(task, dict)
                and (task.get("task_id") == last_task_id or task.get("status") in _ACTIVE_TASK_STATUSES)
            ]
    payload["model_catalog_tasks"] = model_catalog_tasks
    return payload


_shutdown_callbacks: list[Callable[[], None]] = []


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Run registered cleanup during uvicorn's graceful shutdown.

    uvicorn re-raises the terminating signal right after the lifespan shutdown,
    so this is the last place where the tunnel can be stopped on SIGTERM/SIGINT.
    """
    management = None
    management_task = None
    port = getattr(_app.state, 'desktop_management_port', None)
    if port:
        class LocalServer(uvicorn.Server):
            @contextmanager
            def capture_signals(self):
                yield
        management = LocalServer(uvicorn.Config(
            create_management_app(_app.state.desktop, port), host='127.0.0.1',
            port=port, log_level='warning', access_log=False, proxy_headers=False))
        management_task = asyncio.create_task(management.serve())
        while not management.started:
            if management_task.done():
                await management_task
                raise RuntimeError('Local desktop management listener failed to start.')
            await asyncio.sleep(.01)
    # GIL-safe import runs in the background only when desktop was locally
    # enabled. Listener startup does not join optional native initialization.
    if getattr(sys, 'frozen', False) and _app.state.desktop.enabled:
        _app.state.desktop.warm_media()
    try:
        yield
    finally:
        await _app.state.desktop.stop()
        if management:
            management.should_exit = True
            await management_task
        for callback in _shutdown_callbacks:
            callback()


def _tunnel_snapshot(request: Request) -> dict[str, Any]:
    """Report the supervised tunnel; a source run without one reports disabled."""
    supervisor = getattr(request.app.state, "tunnel", None)
    return supervisor.snapshot() if supervisor is not None else disabled_snapshot()


def create_app(*, data_dir: Path | None = None, dist_dir: Path | None = None) -> FastAPI:
    store = DeviceStore((data_dir or DEFAULT_DATA_DIR) / "remote.sqlite3")
    static_root = dist_dir or DEFAULT_DIST_DIR
    computer_model = _computer_model()

    app = FastAPI(title="Haish Remote", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["capacitor://localhost", "https://localhost"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Accept", "Authorization", "Content-Type"],
    )
    app.state.device_store = store
    desktop = DesktopManager(data_dir or DEFAULT_DATA_DIR, store)
    app.state.desktop = desktop

    async def current_device(request: Request) -> dict[str, Any]:
        device = store.authenticate(_token_from_request(request))
        if device is None:
            raise HTTPException(status_code=401, detail="Pair this device with Haish first.")
        return device

    async def desktop_or_current_device(request: Request) -> dict[str, Any]:
        if _is_loopback(request):
            return {"device_id": "desktop"}
        return await current_device(request)

    async def runtime_online() -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.5, trust_env=False) as client:
                response = await client.get(f"{discover_upstream()}/api/health")
                return response.is_success
        except (RuntimeError, httpx.HTTPError):
            return False

    @app.get("/remote/status")
    async def status(request: Request) -> JSONResponse:
        device = store.authenticate(_token_from_request(request))
        return JSONResponse({
            "version": ADAPTER_VERSION,
            "paired": device is not None,
            "device": device,
            "runtime_online": await runtime_online(),
            "computer_model": computer_model,
            "tunnel": _tunnel_snapshot(request),
        })

    @app.get('/remote/desktop/status')
    async def desktop_status(_: dict[str, Any] = Depends(current_device)):
        return JSONResponse(desktop.status(), headers={'cache-control': 'no-store'})

    @app.get('/remote/desktop/ice')
    async def desktop_ice(device: dict[str, Any] = Depends(current_device)):
        desktop.ready()
        servers, configured = ice_servers(subject=device['device_id'])
        return JSONResponse({'iceServers': servers, 'turn_configured': configured, 'expires_in': 600},
                            headers={'cache-control': 'no-store'})

    @app.post('/remote/desktop/offer')
    async def desktop_offer(request: Request, device: dict[str, Any] = Depends(current_device)):
        try:
            length = int(request.headers.get('content-length', '0'))
        except ValueError:
            raise HTTPException(422, 'Invalid desktop offer length.') from None
        if length > 131072:
            raise HTTPException(413, 'Desktop offer too large.')
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 131072:
                raise HTTPException(413, 'Desktop offer too large.')
        try:
            payload = json.loads(raw)
            if payload.get('type') != 'offer' or not isinstance(payload.get('sdp'), str) or len(payload['sdp']) > 100000:
                raise ValueError
        except (ValueError, AttributeError):
            raise HTTPException(422, 'Invalid desktop offer.') from None
        return JSONResponse(await desktop.offer(device['device_id'], payload['sdp']), headers={'cache-control': 'no-store'})

    @app.delete('/remote/desktop/sessions/{session_id}')
    async def end_desktop(session_id: str, device: dict[str, Any] = Depends(current_device)):
        session = desktop.session
        if session and session.id == session_id and session.device_id == device['device_id']:
            await desktop.stop(session=session)
        return {'ok': True}

    @app.post("/remote/pairing/start")
    async def start_pairing(request: Request) -> JSONResponse:
        if not _is_loopback(request):
            raise HTTPException(status_code=403, detail="Pairing codes can only be created on this computer.")
        try:
            endpoint = _public_endpoint()
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        code = store.issue_pairing_code()
        return JSONResponse({
            "code": code,
            "endpoint": endpoint,
            "pairing_uri": _pairing_uri(code),
            "expires_in": PAIRING_TTL_SECONDS,
        })

    @app.post("/remote/pairing/exchange")
    async def exchange_pairing(payload: PairingRequest, request: Request) -> JSONResponse:
        result = store.exchange(payload.code, _remote_device_name(request))
        if result is None:
            raise HTTPException(status_code=400, detail="The pairing code is invalid or expired.")
        token, device = result
        response = JSONResponse({"ok": True, "device": device, "token": token})
        forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        response.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            secure=forwarded_proto == "https",
            samesite="strict",
            max_age=60 * 60 * 24 * 90,
            path="/",
        )
        return response

    @app.get("/remote/devices")
    async def devices(_: dict[str, Any] = Depends(desktop_or_current_device)) -> JSONResponse:
        return JSONResponse({"devices": store.list_devices()})

    @app.get("/remote/conversation-reads")
    async def conversation_reads(_: dict[str, Any] = Depends(desktop_or_current_device)) -> JSONResponse:
        return JSONResponse({"seen_at": store.conversation_reads()})

    @app.put("/remote/conversation-reads/{conversation_id}")
    async def mark_conversation_read(
        conversation_id: str,
        payload: ConversationReadRequest,
        device: dict[str, Any] = Depends(desktop_or_current_device),
    ) -> JSONResponse:
        if not _SAFE_CONVERSATION_ID.fullmatch(conversation_id):
            raise HTTPException(status_code=422, detail="Invalid conversation ID.")
        seen_at_ms = store.mark_conversation_read(
            conversation_id,
            payload.seen_at_ms,
            str(device.get("device_id") or "unknown"),
        )
        return JSONResponse({"conversation_id": conversation_id, "seen_at_ms": seen_at_ms})

    @app.delete("/remote/devices/{device_id}")
    async def revoke_device(device_id: str, _: dict[str, Any] = Depends(desktop_or_current_device)) -> JSONResponse:
        if not store.revoke(device_id):
            raise HTTPException(status_code=404, detail="Device not found.")
        await desktop.stop(device_id=device_id)
        return JSONResponse({"ok": True})

    @app.post("/remote/logout")
    async def logout(request: Request, device: dict[str, Any] = Depends(current_device)) -> JSONResponse:
        store.revoke(device["device_id"])
        await desktop.stop(device_id=device['device_id'])
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE_NAME, path="/")
        return response

    @app.post("/remote/conversations/{conversation_id}/tasks")
    async def start_task(
        conversation_id: str,
        payload: TaskStartRequest,
        _: dict[str, Any] = Depends(current_device),
    ) -> Response:
        stream = RealtimeTaskStream(conversation_id=conversation_id, payload=payload.model_dump())
        try:
            first = await stream.open()
        except TaskStreamError as error:
            return JSONResponse(content={"detail": error.detail}, status_code=error.status)
        return StreamingResponse(stream.body_lines(first), status_code=200, headers=NDJSON_HEADERS)

    # The runtime removed the HTTP resolve routes; the phone keeps its endpoints but
    # the adapter sends approval.resolve over the realtime socket.
    @app.post("/api/approvals/{request_id}/resolve")
    async def resolve_tool_approval(
        request_id: str,
        request: Request,
        _: dict[str, Any] = Depends(current_device),
    ) -> JSONResponse:
        return await _resolve_realtime_approval(request, approval_id=request_id, approval_kind="tool")

    @app.post("/api/workflow-approvals/{request_id}/resolve")
    async def resolve_workflow_approval(
        request_id: str,
        request: Request,
        _: dict[str, Any] = Depends(current_device),
    ) -> JSONResponse:
        return await _resolve_realtime_approval(request, approval_id=request_id, approval_kind="workflow")

    @app.post("/api/user-inputs/{request_id}/resolve")
    async def resolve_user_input(
        request_id: str,
        request: Request,
        _: dict[str, Any] = Depends(current_device),
    ) -> JSONResponse:
        return await _resolve_realtime_approval(request, approval_id=request_id, approval_kind="user_input")

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def proxy_core(
        path: str,
        request: Request,
        _: dict[str, Any] = Depends(current_device),
    ) -> Response:
        if not _route_allowed(request.method, path):
            raise HTTPException(status_code=403, detail="This core endpoint is not available to remote devices.")
        try:
            upstream = f"{discover_upstream()}/api/{path}"
        except RuntimeError as error:
            # The runtime is stopped or restarting; report it like the task start
            # does so the phone shows its reconnect state instead of a 500.
            return JSONResponse(content={"detail": str(error)}, status_code=503)
        if request.url.query:
            upstream += f"?{request.url.query}"
        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() in {"accept", "content-type", "if-none-match"}
        }
        client = httpx.AsyncClient(timeout=None, trust_env=False)
        try:
            upstream_request = client.build_request(request.method, upstream, content=body, headers=headers)
            upstream_response = await client.send(upstream_request, stream=True)
        except Exception:
            await client.aclose()
            raise

        response_headers = {
            key: value
            for key, value in upstream_response.headers.items()
            if key.lower() in {"content-type", "cache-control", "etag", "content-disposition"}
        }

        async def read_upstream_json() -> tuple[bytes, Any]:
            """Drain the upstream body once; ``None`` when it is not JSON."""
            raw = await upstream_response.aread()
            await upstream_response.aclose()
            await client.aclose()
            try:
                return raw, json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                return raw, None

        def rewritten_json(payload: Any) -> Response:
            """Re-send a shaped payload; a rewritten body cannot keep the upstream ETag."""
            shaped_headers = {
                key: value
                for key, value in response_headers.items()
                if key.lower() not in {"content-type", "etag"}
            }
            return JSONResponse(content=payload, status_code=upstream_response.status_code, headers=shaped_headers)

        def upstream_error(raw: bytes) -> Response:
            return Response(content=raw, status_code=upstream_response.status_code, headers=response_headers)

        if request.method == "GET" and upstream_response.is_success and path == "projects":
            raw, payload = await read_upstream_json()
            if payload is None:
                return upstream_error(raw)
            return rewritten_json(_compact_project_listing(payload))

        # The runtime API never exposes the provider a task ran with, so the phone
        # would have to guess it from the coarse `provider_key`. PATCH answers with
        # the same record (the first-message rename reads it back), same fill-in.
        if request.method in {"GET", "PATCH"} and upstream_response.is_success and _is_conversation_detail(path):
            raw, payload = await read_upstream_json()
            if payload is None:
                return upstream_error(raw)
            # Reading a conversation record is file work measured in megabytes.
            return rewritten_json(await asyncio.to_thread(_attach_requested_providers, payload))

        async def body_iter():
            try:
                async for chunk in upstream_response.aiter_bytes():
                    yield chunk
            finally:
                await upstream_response.aclose()
                await client.aclose()

        return StreamingResponse(body_iter(), status_code=upstream_response.status_code, headers=response_headers)

    @app.get("/{path:path}", include_in_schema=False)
    async def static_files(path: str):
        requested = (static_root / (path or "index.html")).resolve()
        try:
            requested.relative_to(static_root.resolve())
        except ValueError:
            raise HTTPException(status_code=404)
        if requested.is_file():
            return FileResponse(requested)
        index = static_root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse(
            {"detail": "Mobile UI is not built. Run npm install && npm run build."},
            status_code=503,
        )

    return app


app = create_app()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Haish Remote adapter")
    parser.add_argument("command", choices=["serve", "pair"], nargs="?", default="serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--version", action="version", version=f"haish-remote-adapter {ADAPTER_VERSION}")
    args = parser.parse_args(argv)
    if args.command == "pair":
        code = DeviceStore(DEFAULT_DATA_DIR / "remote.sqlite3").issue_pairing_code()
        print(f"Pairing code: {code[:4]} {code[4:]}")
        print("Expires in 5 minutes.")
        return
    # The adapter owns its public presence: keep the bundled frpc alive while we
    # serve. A misconfigured tunnel fails the start instead of going silent.
    try:
        tunnel_settings = TunnelSettings.from_env(
            os.environ,
            local_port=args.port,
            data_dir=DEFAULT_DATA_DIR,
        )
    except TunnelConfigError as error:
        raise SystemExit(f"error: {error}") from error
    if tunnel_settings is not None:
        supervisor = TunnelSupervisor(tunnel_settings)
        supervisor.start()
        app.state.tunnel = supervisor
        # uvicorn re-raises the terminating signal after the lifespan shutdown, so
        # the graceful path must stop frpc itself; atexit only covers plain exits.
        _shutdown_callbacks.append(supervisor.stop)
        atexit.register(supervisor.stop)
        print(
            f"[haish-remote] tunnel: frpc → {tunnel_settings.server_label}"
            f" (remote port {tunnel_settings.remote_port}, local port {tunnel_settings.local_port})",
            flush=True,
        )
    # Serve this module's app object directly: frozen builds execute the module as
    # __main__, and importing "server.app" by name would build a second instance.
    app.state.desktop_management_port = int(os.getenv('HAISH_DESKTOP_MANAGEMENT_PORT', '8767'))
    uvicorn.run(app, host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
