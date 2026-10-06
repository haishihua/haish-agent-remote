"""Bark delivery belongs to the adapter, not the phone's polling lifecycle.

Only the official HTTPS provider is supported, avoiding a device-controlled SSRF
endpoint. Secrets never appear in URLs, status responses or exception logs.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
import re
import time
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx


KEY = re.compile(r"^[A-Za-z0-9_-]{8,200}$")
SCHEMA = """
CREATE TABLE IF NOT EXISTS bark_config (
    device_id TEXT PRIMARY KEY, device_key TEXT NOT NULL,
    enabled_at REAL NOT NULL, generation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bark_deliveries (
    device_id TEXT NOT NULL, task_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    state TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
    generation TEXT NOT NULL, PRIMARY KEY(device_id, task_id)
);
"""


def request_preview(task: dict) -> str:
    raw = task.get('display_text')
    if raw is None:
        raw = task.get('title') or ''
    text = str(raw)
    text = re.sub(r'^\s*\[user attached image #\d+:\s*[^\]]+\]\s*$', '', text, flags=re.I | re.M)
    text = re.split(r'\s*The user attached the image\(s\) above\.', text, flags=re.I)[0]
    text = re.sub(r'\[user attached image #[^\]]*$', '', text, flags=re.I)
    return re.sub(r'\s+', ' ', text).strip()[:160] or 'Task request'


def timestamp(value) -> float:
    try:
        if isinstance(value, (float, int)):
            return value / 1000 if value > 10_000_000_000 else float(value)
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


def all_tasks(payload: dict):
    # This MUST be the direct, non-compacted runtime response, summary_only=false.
    for project in payload['projects']:
        for conversation in project.get('conversations', []):
            for task in conversation.get('tasks', []):
                yield {**task, 'conversation_id': conversation['conversation_id']}


class BarkService:
    def __init__(self, store, discover_upstream, public_endpoint):
        self.store = store
        self.discover_upstream = discover_upstream
        self.public_endpoint = public_endpoint
        with store._connect() as db:
            db.executescript(SCHEMA)

    def status(self, device_id: str) -> dict:
        with self.store._connect() as db:
            enabled = db.execute('SELECT 1 FROM bark_config WHERE device_id = ?', (device_id,)).fetchone()
            counts = db.execute("SELECT state, count(*) AS n FROM bark_deliveries WHERE device_id = ? GROUP BY state", (device_id,)).fetchall()
        return {'enabled': bool(enabled), 'provider': 'Bark', 'delivery_counts': {r['state']: r['n'] for r in counts}}

    def configure(self, device_id: str, device_key: str):
        if not isinstance(device_key, str) or not KEY.fullmatch(device_key):
            raise ValueError('Enter the Bark device key (8–200 letters, numbers, hyphens or underscores).')
        # Changing a key cancels old pending work; an identical save is idempotent.
        with self.store._connect() as db:
            existing = db.execute('SELECT device_key FROM bark_config WHERE device_id = ?', (device_id,)).fetchone()
            if existing and existing['device_key'] == device_key:
                return
            generation = uuid4().hex
            db.execute('INSERT OR REPLACE INTO bark_config VALUES (?, ?, ?, ?)', (device_id, device_key, time.time(), generation))
            db.execute("UPDATE bark_deliveries SET state = 'ignored', body = '' WHERE device_id = ? AND state IN ('pending', 'active')", (device_id,))
        self.store.path.chmod(0o600)

    def disable(self, device_id: str):
        with self.store._connect() as db:
            db.execute('DELETE FROM bark_config WHERE device_id = ?', (device_id,))
            db.execute("UPDATE bark_deliveries SET state = 'ignored', body = '' WHERE device_id = ? AND state IN ('pending', 'active')", (device_id,))

    def observe(self, tasks: list[dict]):
        with self.store._connect() as db:
            configs = db.execute('SELECT c.* FROM bark_config c JOIN devices d USING(device_id) WHERE d.revoked_at IS NULL').fetchall()
            for config in configs:
                for task in tasks:
                    task_id = str(task.get('task_id') or '')
                    conversation_id = str(task.get('conversation_id') or '')
                    if not task_id or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', conversation_id):
                        continue
                    status = str(task.get('status') or '').lower().strip()
                    outcome = 'done' if status in {'done', 'completed'} else 'failed' if status in {'failed', 'error'} else ''
                    old = db.execute('SELECT * FROM bark_deliveries WHERE device_id = ? AND task_id = ?', (config['device_id'], task_id)).fetchone()
                    if old and (old['state'] in {'sent', 'pending', 'failed'} or (old['state'] == 'ignored' and old['generation'] == config['generation'])):
                        continue
                    body = request_preview(task)
                    if body == 'Task request' and old and task.get('display_text') is None and not task.get('title'):
                        body = old['body'] or 'Task request'
                    eligible = (old is not None and old['generation'] == config['generation']) or timestamp(task.get('completed_at')) >= config['enabled_at']
                    state = 'pending' if outcome and eligible else 'active' if status in {'queued', 'running', 'waiting_input'} else 'ignored'
                    db.execute('INSERT OR REPLACE INTO bark_deliveries(device_id, task_id, conversation_id, state, body, outcome, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
                               (config['device_id'], task_id, conversation_id, state, body if state in {'active', 'pending'} else '', outcome, config['generation']))

    async def deliver(self, client: httpx.AsyncClient):
        with self.store._connect() as db:
            rows = db.execute("""SELECT n.*, c.device_key FROM bark_deliveries n
                JOIN bark_config c ON c.device_id = n.device_id AND c.generation = n.generation
                JOIN devices d ON d.device_id = n.device_id
                WHERE d.revoked_at IS NULL AND n.state = 'pending' AND n.next_attempt <= ? LIMIT 20""", (time.time(),)).fetchall()
        if not rows:
            return
        endpoint = self.public_endpoint().rstrip('/')
        parsed = urlsplit(endpoint)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('A public HTTPS endpoint is required for the notification icon.')
        for row in rows:
            # Recheck immediately before each external send, including revocation.
            with self.store._connect() as db:
                valid = db.execute('SELECT 1 FROM bark_config c JOIN devices d USING(device_id) WHERE c.device_id = ? AND c.generation = ? AND d.revoked_at IS NULL', (row['device_id'], row['generation'])).fetchone()
                claimed = db.execute("UPDATE bark_deliveries SET next_attempt = ? WHERE device_id = ? AND task_id = ? AND generation = ? AND state = 'pending' AND next_attempt <= ?", (time.time() + 60, row['device_id'], row['task_id'], row['generation'], time.time())).rowcount if valid else 0
            if not claimed:
                continue
            payload = {
                'device_key': row['device_key'],
                'title': 'Task completed' if row['outcome'] == 'done' else 'Task failed',
                'body': row['body'], 'group': 'Haish tasks', 'isArchive': '0',
                'icon': f'{endpoint}/remote/notification-icon.png',
                'url': f"haish://conversation/{quote(row['conversation_id'], safe='')}?device={quote(row['device_id'], safe='')}",
            }
            attempts = row['attempts'] + 1
            state = 'pending'
            try:
                response = await client.post('https://api.day.app/push', json=payload)
                try:
                    result = response.json()
                except ValueError:
                    result = None
                if response.is_success and isinstance(result, dict) and result.get('code') == 200:
                    state = 'sent'
                elif response.status_code in {400, 401, 403, 404, 410, 422} or (isinstance(result, dict) and result.get('code') in {400, 401, 403, 404, 410, 422}):
                    state = 'failed'
            except (httpx.HTTPError, ValueError):
                pass  # Never persist/log exception text or provider responses (may echo secrets).
            if attempts >= 8 and state == 'pending':
                state = 'failed'
            with self.store._connect() as db:
                db.execute("UPDATE bark_deliveries SET state = ?, attempts = ?, next_attempt = ?, body = CASE WHEN ? != 'pending' THEN '' ELSE body END WHERE device_id = ? AND task_id = ? AND generation = ? AND state = 'pending'",
                           (state, attempts, time.time() + min(3600, 5 * 2 ** attempts), state, row['device_id'], row['task_id'], row['generation']))

    async def run(self):
        async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
            while True:
                try:
                    with self.store._connect() as db:
                        enabled = db.execute('SELECT 1 FROM bark_config c JOIN devices d USING(device_id) WHERE d.revoked_at IS NULL LIMIT 1').fetchone()
                    if enabled:
                        response = await client.get(f'{self.discover_upstream()}/api/projects?execution_mode=chat&summary_only=false')
                        response.raise_for_status()
                        self.observe(list(all_tasks(response.json())))
                except Exception:
                    # Runtime downtime is NOT task failure. Pending sends still get retried.
                    pass
                try:
                    await self.deliver(client)
                except Exception:
                    pass
                await asyncio.sleep(5)
