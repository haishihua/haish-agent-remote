from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import time
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
import uvicorn


COOKIE_NAME = "haish_remote_device"
PAIRING_TTL_SECONDS = 5 * 60
DEFAULT_DATA_DIR = Path(os.getenv("HAISH_REMOTE_DATA_DIR", "~/.haish-remote")).expanduser()
DEFAULT_DIST_DIR = Path(__file__).resolve().parents[1] / "dist"

_ALLOWED_CORE_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (method, re.compile(pattern))
    for method, pattern in (
        ("GET", r"conversations"),
        ("POST", r"conversations"),
        ("GET", r"projects"),
        ("GET", r"agents"),
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
        ("POST", r"approvals/[^/]+/resolve"),
        ("POST", r"workflow-approvals/[^/]+/resolve"),
        ("POST", r"user-inputs/[^/]+/resolve"),
    )
)

_ACTIVE_TASK_STATUSES = {"queued", "running"}
_PROJECT_LIST_TASK_FIELDS = (
    "task_id",
    "conversation_id",
    "status",
    "stage",
    "created_at",
    "updated_at",
    "completed_at",
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
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

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


class PairingRequest(BaseModel):
    code: str = Field(pattern=r"^\d{8}$")


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
    message: str = Field(min_length=1, max_length=20_000)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    image_attachments: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


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


def _token_from_request(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(COOKIE_NAME)


def _is_loopback(request: Request) -> bool:
    return bool(request.client and request.client.host in {"127.0.0.1", "::1", "localhost", "testclient"})


def _route_allowed(method: str, path: str) -> bool:
    return any(method == allowed_method and pattern.fullmatch(path) for allowed_method, pattern in _ALLOWED_CORE_ROUTES)


def _compact_project_listing(payload: Any) -> Any:
    """Keep directory polling lightweight; conversation detail is fetched on demand."""
    if not isinstance(payload, dict) or not isinstance(payload.get("projects"), list):
        return payload
    for project in payload["projects"]:
        if not isinstance(project, dict) or not isinstance(project.get("conversations"), list):
            continue
        for conversation in project["conversations"]:
            if not isinstance(conversation, dict):
                continue
            last_task_id = conversation.get("last_task_id")
            tasks = conversation.get("tasks") if isinstance(conversation.get("tasks"), list) else []
            conversation["tasks"] = [
                {field: task[field] for field in _PROJECT_LIST_TASK_FIELDS if field in task}
                for task in tasks
                if isinstance(task, dict)
                and (task.get("task_id") == last_task_id or task.get("status") in _ACTIVE_TASK_STATUSES)
            ]
    return payload


def create_app(*, data_dir: Path | None = None, dist_dir: Path | None = None) -> FastAPI:
    store = DeviceStore((data_dir or DEFAULT_DATA_DIR) / "remote.sqlite3")
    static_root = dist_dir or DEFAULT_DIST_DIR
    computer_model = _computer_model()

    app = FastAPI(title="Haish Remote")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["capacitor://localhost", "https://localhost"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Accept", "Authorization", "Content-Type"],
    )
    app.state.device_store = store

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
        return JSONResponse({"paired": device is not None, "device": device, "runtime_online": await runtime_online(), "computer_model": computer_model})

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

    @app.delete("/remote/devices/{device_id}")
    async def revoke_device(device_id: str, _: dict[str, Any] = Depends(desktop_or_current_device)) -> JSONResponse:
        if not store.revoke(device_id):
            raise HTTPException(status_code=404, detail="Device not found.")
        return JSONResponse({"ok": True})

    @app.post("/remote/logout")
    async def logout(request: Request, device: dict[str, Any] = Depends(current_device)) -> JSONResponse:
        store.revoke(device["device_id"])
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE_NAME, path="/")
        return response

    @app.post("/remote/conversations/{conversation_id}/tasks")
    async def start_task(
        conversation_id: str,
        payload: TaskStartRequest,
        _: dict[str, Any] = Depends(current_device),
    ) -> Response:
        client = httpx.AsyncClient(timeout=None, trust_env=False)
        try:
            request = client.build_request(
                "POST",
                f"{discover_upstream()}/api/conversations/{conversation_id}/tasks/stream",
                json=payload.model_dump(),
            )
            response = await client.send(request, stream=True)
            if not response.is_success:
                body = await response.aread()
                await response.aclose()
                await client.aclose()
                try:
                    content = json.loads(body or b"{}")
                except json.JSONDecodeError:
                    content = {"detail": body.decode("utf-8", errors="replace") or "The Haish runtime rejected the task."}
                return JSONResponse(content=content, status_code=response.status_code)
        except Exception:
            await client.aclose()
            raise

        async def body_iter():
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()
                await client.aclose()

        return StreamingResponse(
            body_iter(),
            status_code=response.status_code,
            headers={
                "content-type": response.headers.get("content-type", "application/x-ndjson"),
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def proxy_core(
        path: str,
        request: Request,
        _: dict[str, Any] = Depends(current_device),
    ) -> Response:
        if not _route_allowed(request.method, path):
            raise HTTPException(status_code=403, detail="This core endpoint is not available to remote devices.")
        upstream = f"{discover_upstream()}/api/{path}"
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

        if request.method == "GET" and path == "projects" and upstream_response.is_success:
            body = await upstream_response.aread()
            await upstream_response.aclose()
            await client.aclose()
            try:
                compacted = _compact_project_listing(json.loads(body))
            except (TypeError, json.JSONDecodeError):
                return Response(content=body, status_code=upstream_response.status_code, headers=response_headers)
            compact_headers = {
                key: value
                for key, value in response_headers.items()
                if key.lower() not in {"content-type", "etag"}
            }
            return JSONResponse(content=compacted, status_code=upstream_response.status_code, headers=compact_headers)

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
    args = parser.parse_args(argv)
    if args.command == "pair":
        code = DeviceStore(DEFAULT_DATA_DIR / "remote.sqlite3").issue_pairing_code()
        print(f"Pairing code: {code[:4]} {code[4:]}")
        print("Expires in 5 minutes.")
        return
    uvicorn.run("server.app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
