"""Authenticated desktop signaling and a single-controller, fail-closed lease."""
import asyncio
import base64
from fractions import Fraction
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import time

from fastapi import HTTPException
from server.macos_desktop import KEYS, MacDesktop

# A ticket expires from SERVER issuance, not receipt. A delayed heartbeat cannot
# extend an older command's validity; neither side needs synchronized wall clocks.
INPUT_LEASE_SECONDS = 1.0
NEGOTIATION_SECONDS = 12


def ice_servers(env=None, now=None, subject='device'):
    env = os.environ if env is None else env
    urls = [u.strip() for u in env.get('HAISH_DESKTOP_TURN_URLS', '').split(',') if u.strip()]
    secret = env.get('HAISH_DESKTOP_TURN_SECRET', '')
    if not urls or not secret:
        return [], False
    if not all(u.startswith(('turn:', 'turns:')) and '@' not in u for u in urls):
        raise HTTPException(503, 'Invalid TURN configuration on the computer.')
    username = f'{int(time.time() if now is None else now) + 600}:{subject}'
    password = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
    return [{'urls': urls, 'username': username, 'credential': password}], True


def load_media():
    # Native dlopen otherwise holds the GIL even in a worker thread on macOS.
    from server.frozen_media import install_gil_safe_loader
    from server.media_diagnostics import media_stage
    with media_stage('loader_setup'):
        from server.packaged_media import install_packaged_media
        install_packaged_media()
        install_gil_safe_loader()
    with media_stage('av_import'):
        import av  # aiortc imports this same pinned dependency; isolate its cost
    with media_stage('aiortc_import'):
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, VideoStreamTrack
    return RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, VideoStreamTrack


def validate_input(m):
    if not isinstance(m, dict):
        return False
    kind = m.get('type')
    if kind in ('ping', 'resume'):
        return (type(m.get('generation')) is int and 0 <= m['generation'] <= 2**53 - 1 and
                isinstance(m.get('probe'), str) and 0 < len(m['probe']) <= 128 and
                all(isinstance(m.get(k, []), list) and len(m.get(k, [])) <= 16 and
                    all(v in allowed for v in m.get(k, []))
                    for k, allowed in (('heldKeys', KEYS), ('heldButtons', ('left', 'right')))))
    if kind == 'release':
        return True
    if kind in ('move', 'scroll'):
        limit = 1 if kind == 'move' else 1000
        return all(isinstance(m.get(k), (int, float)) and not isinstance(m[k], bool) and
                   math.isfinite(m[k]) and abs(m[k]) <= limit for k in ('dx', 'dy'))
    if kind in ('click', 'button'):
        return m.get('button') in ('left', 'right') and (
            type(m.get('down')) is bool if kind == 'button' else type(m.get('count', 1)) is int and m.get('count', 1) in (1, 2))
    if kind == 'key':
        return m.get('key') in KEYS and type(m.get('down')) is bool
    if kind == 'text':
        return isinstance(m.get('text'), str) and 0 < len(m['text']) <= 1024 and not any(0xD800 <= ord(c) <= 0xDFFF for c in m['text'])
    return False


class DesktopManager:
    def __init__(self, data_dir: Path, store, backend=None):
        self.store = store
        self.backend = backend or MacDesktop()
        self.path = data_dir / 'desktop.json'
        try:
            self.enabled = json.loads(self.path.read_text()).get('enabled') is True
        except (OSError, ValueError, AttributeError):
            self.enabled = False
        self.session = None
        self.lock = asyncio.Lock()
        self.media_task = None
        from server.media_diagnostics import MediaDiagnostics
        self.media_diagnostics = MediaDiagnostics()

    def _load_media(self):
        from server.media_diagnostics import observe_native_loads
        diagnostics = self.media_diagnostics
        diagnostics.begin()
        success = False
        try:
            with observe_native_loads(diagnostics):
                result = load_media()
            success = True
            return result
        finally:
            diagnostics.end(success)

    def warm_media(self):
        # A shared background import, never awaited by listener startup. A
        # timed-out offer must not cancel it or launch another native import.
        if self.media_task is None or (self.media_task.done() and
                                     (self.media_task.cancelled() or self.media_task.exception())):
            self.media_task = asyncio.create_task(asyncio.to_thread(self._load_media))
            self.media_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        return self.media_task

    def status(self):
        return {**self.backend.status(), 'enabled': self.enabled, 'busy': self.session is not None,
                'turn_configured': bool(os.getenv('HAISH_DESKTOP_TURN_URLS') and os.getenv('HAISH_DESKTOP_TURN_SECRET'))}

    def ready(self):
        status = self.status()
        for field, detail in (
            ('enabled', 'Remote desktop is disabled. Enable it on the computer at http://127.0.0.1:8767.'),
            ('supported', 'Requires Apple Silicon macOS 14.8.9 or later and the desktop dependencies.'),
            ('screen_recording', 'Screen Recording permission missing. Open System Settings → Privacy & Security → Screen Recording, then retry.'),
            ('accessibility', 'Accessibility permission missing. Open System Settings → Privacy & Security → Accessibility, then retry.'),
            ('unlocked', 'Locked or sleeping computers are not supported. Unlock the Mac locally, then reconnect.'),
        ):
            if not status[field]:
                raise HTTPException(409, detail)

    async def set_enabled(self, enabled):
        # Local management and signaling share the same event loop.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps({'enabled': enabled}))
        temp.chmod(0o600)
        temp.replace(self.path)
        self.enabled = enabled
        if enabled:
            self.warm_media()
        else:
            await self.stop()

    def authorized(self, session):
        return any(d['device_id'] == session.device_id for d in self.store.list_devices())

    async def offer(self, device_id, sdp):
        async with self.lock:
            self.ready()
            if self.session:
                raise HTTPException(409, 'This Mac is busy with another desktop session. End it before reconnecting.')
            try:
                RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, VideoStreamTrack = (
                    await asyncio.wait_for(asyncio.shield(self.warm_media()), NEGOTIATION_SECONDS))
            except ImportError:
                raise HTTPException(503, 'Desktop media dependencies are unavailable.') from None
            except TimeoutError:
                raise HTTPException(503, 'Desktop media initialization timed out. Retry after initialization completes.') from None
            self.ready()  # local disable/permission changes may occur during import
            servers, configured = ice_servers(subject=device_id)
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**s) for s in servers]))
            session = DesktopSession(self, device_id, pc)
            self.session = session

            manager = self

            class ScreenTrack(VideoStreamTrack):
                async def recv(self):
                    # Never capture without a live, authenticated foreground lease.
                    while not session.active():
                        if session.closed:
                            from aiortc.mediastreams import MediaStreamError
                            raise MediaStreamError
                        await asyncio.sleep(.05)
                    delay = max(0, session.next_frame - time.monotonic())
                    await asyncio.sleep(delay)
                    session.next_frame = time.monotonic() + 1/session.fps
                    if not session.active():
                        return await self.recv()
                    frame = await asyncio.to_thread(manager.backend.capture, session.width, session.height)
                    if not session.active():
                        return await self.recv()
                    frame.pts = int((time.monotonic() - session.started) * 90000)
                    frame.time_base = Fraction(1, 90000)
                    return frame

            pc.addTrack(ScreenTrack())

            @pc.on('datachannel')
            def channel_open(channel):
                if channel.label != 'input' or session.channel is not None:
                    channel.close()
                    return
                session.channel = channel
                channel.on('message', session.message)
                channel.on('close', session.suspend)

            @pc.on('connectionstatechange')
            async def connection_changed():
                if pc.connectionState in ('disconnected', 'failed', 'closed'):
                    session.suspend()
                if pc.connectionState in ('failed', 'closed'):
                    await self.stop(session=session)

            session.watchdog = asyncio.create_task(session.watch())
            try:
                # mDNS candidate resolution in setRemoteDescription can block
                # too; bound the entire negotiation, not only ICE gathering.
                async with asyncio.timeout(NEGOTIATION_SECONDS):
                    from server.desktop_mdns import resolve_local_candidates
                    sdp = await resolve_local_candidates(sdp)
                    await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type='offer'))
                    await pc.setLocalDescription(await pc.createAnswer())
                return {'session_id': session.id, 'sdp': pc.localDescription.sdp,
                        'type': 'answer', 'turn_configured': configured}
            except asyncio.CancelledError:
                await self.stop(session=session)
                raise
            except Exception:
                await self.stop(session=session)
                raise HTTPException(503, 'Desktop negotiation failed. Check network/TURN and retry.') from None

    async def stop(self, device_id=None, session=None):
        current = self.session
        if current is None or (device_id and current.device_id != device_id) or (session and session is not current):
            return
        # One session-owned cleanup task: HTTP cancellation must not cancel
        # aiortc.close(), which otherwise leaves its internal close Future pending
        # forever. Concurrent disable/watchdog/connection callbacks join the same
        # task rather than trying to close the peer again.
        if current.close_task is None:
            current.closed = True
            current.suspend()
            if current.watchdog and current.watchdog is not asyncio.current_task():
                current.watchdog.cancel()

            async def cleanup():
                try:
                    await current.pc.close()
                finally:
                    if self.session is current:
                        self.session = None

            current.close_task = asyncio.create_task(cleanup())
        await asyncio.shield(current.close_task)


class DesktopSession:
    def __init__(self, manager, device_id, pc):
        self.manager, self.device_id, self.pc = manager, device_id, pc
        self.id = secrets.token_urlsafe(24)
        self.epoch = secrets.token_urlsafe(16)
        self.channel = None
        self.watchdog = None
        self.close_task = None
        self.closed = False
        self.last_ping = None
        self.generation = -1
        self.control_active = False
        self.tickets = {}
        self.held_keys = set()
        self.held_buttons = set()
        self.started = time.monotonic()
        self.last_live = self.started
        self.last_seq = -1
        self.next_frame = self.started
        self.width, self.height, self.fps = None, None, 30
        self.input_diagnostics = {'received': 0, 'accepted': 0, 'rejected': 0, 'native_errors': 0}
        self.bucket = 0
        self.bucket_start = self.started

    def active(self):
        try:
            self.manager.ready()
            return (not self.closed and self.control_active and self.last_ping is not None and
                    time.monotonic() - self.last_ping < INPUT_LEASE_SECONDS and self.manager.authorized(self))
        except Exception:
            return False

    def suspend(self):
        self.last_ping = None
        self.control_active = False
        self.epoch = secrets.token_urlsafe(16)
        self.tickets.clear()
        self.held_keys.clear()
        self.held_buttons.clear()
        self.last_seq = -1
        self.manager.backend.release()

    def message(self, raw):
        # Never log payloads or input text. Bad input is ignored, not reflected.
        if self.closed or not isinstance(raw, str) or len(raw) > 8192:
            return
        try:
            m = json.loads(raw)
            if not validate_input(m):
                return
            self.manager.ready()
            if not self.manager.authorized(self):
                self.suspend()
                asyncio.create_task(self.manager.stop(session=self))
                return
            now = time.monotonic()
            # Apply expiry even when the watchdog hasn't run yet, and BEFORE a
            # returning ping. Expired control cannot be revived by any heartbeat.
            if self.control_active and now - self.last_ping >= INPUT_LEASE_SECONDS:
                self.suspend()
            if m['type'] == 'ping':
                generation = m['generation']
                if generation < self.generation:
                    return
                if generation > self.generation:
                    self.suspend()
                    self.generation = generation
                if m.get('paused') is True and self.control_active:
                    # A lost resume acknowledgment must not leave the server
                    # armed while the phone is still paused. Issue a new challenge.
                    self.suspend()
                self.last_ping = self.last_live = now
                # Partial-reliable input may lose an up/release. Heartbeats only
                # RELEASE absent held state; they never replay a missing down.
                if self.control_active:
                    for key in self.held_keys - set(m.get('heldKeys', [])):
                        self.manager.backend.input({'type': 'key', 'key': key, 'down': False})
                    for button in self.held_buttons - set(m.get('heldButtons', [])):
                        self.manager.backend.input({'type': 'button', 'button': button, 'down': False})
                    self.held_keys.intersection_update(m.get('heldKeys', []))
                    self.held_buttons.intersection_update(m.get('heldButtons', []))
                quality = m.get('quality', 'high')
                self.width, self.height, self.fps = (1280, 720, 15) if quality == 'low' else (None, None, 30)
                ticket = secrets.token_urlsafe(16)
                self.tickets = {k: v for k, v in self.tickets.items() if v > now}
                # Bound allocations even if an authenticated client floods probes.
                if len(self.tickets) >= 8:
                    self.suspend()
                    self.last_ping = now
                self.tickets[ticket] = now + INPUT_LEASE_SECONDS
                self.channel.send(json.dumps({'type': 'ready' if self.control_active else 'challenge',
                    'generation': self.generation, 'probe': m['probe'], 'epoch': self.epoch,
                    'ticket': ticket, 'validForMs': int(INPUT_LEASE_SECONDS * 1000)}))
                return
            valid_ticket = (m.get('generation') == self.generation and m.get('epoch') == self.epoch and
                            self.tickets.get(m.get('ticket'), 0) > now)
            if m['type'] == 'resume':
                if not valid_ticket:
                    return
                # Explicit fresh challenge/response is required after every pause.
                # An old ping alone never arms input or capture.
                self.control_active = True
                self.last_ping = self.last_live = now
                self.channel.send(json.dumps({'type': 'ready', 'generation': self.generation,
                    'probe': m['probe'], 'epoch': self.epoch, 'ticket': m['ticket'],
                    'validForMs': int(max(0, self.tickets[m['ticket']] - now) * 1000)}))
                return
            self.input_diagnostics['received'] += 1
            if not self.active() or not valid_ticket:
                self.input_diagnostics['rejected'] += 1
                return
            seq = m.get('seq')
            if type(seq) is not int or seq <= self.last_seq:
                self.input_diagnostics['rejected'] += 1
                return
            self.last_seq = seq
            if now - self.bucket_start >= 1:
                self.bucket, self.bucket_start = 0, now
            self.bucket += 1
            if self.bucket > 240:
                self.suspend()
                return
            try:
                self.manager.backend.input(m)
            except Exception:
                self.input_diagnostics['native_errors'] += 1
                raise
            self.input_diagnostics['accepted'] += 1
            if m['type'] == 'key':
                (self.held_keys.add if m['down'] else self.held_keys.discard)(m['key'])
            elif m['type'] == 'button':
                (self.held_buttons.add if m['down'] else self.held_buttons.discard)(m['button'])
            elif m['type'] == 'release':
                self.held_keys.clear()
                self.held_buttons.clear()
        except Exception:
            self.suspend()

    async def watch(self):
        previous = time.time()
        while not self.closed:
            await asyncio.sleep(.25)
            now = time.monotonic()
            wall = time.time()
            # A long scheduler gap can mean system sleep; never silently resume.
            try:
                self.manager.ready()
                if not self.manager.authorized(self) or wall - previous > 3:
                    await self.manager.stop(session=self)
                    return
            except Exception:
                await self.manager.stop(session=self)
                return
            previous = wall
            if self.last_ping is not None and now - self.last_ping >= INPUT_LEASE_SECONDS:
                self.suspend()
            if now - self.last_live >= 30:
                await self.manager.stop(session=self)
                return
