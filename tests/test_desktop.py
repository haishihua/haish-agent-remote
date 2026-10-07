import asyncio
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from server.app import create_app, DeviceStore
from server.desktop import DesktopManager, DesktopSession, ice_servers, validate_input
from server.desktop_management import create_management_app


class FakeDesktop:
    def __init__(self):
        self.inputs = []
        self.releases = 0
        self.flags = dict(supported=True, screen_recording=True, accessibility=True, unlocked=True)

    def status(self):
        return self.flags.copy()

    def input(self, message):
        self.inputs.append(message)

    def release(self):
        self.releases += 1

    def capture(self, width, height):
        from av import VideoFrame
        frame = VideoFrame(320, 180, 'yuv420p')
        for plane in frame.planes:
            plane.update(bytes(plane.buffer_size))
        return frame


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.app = create_app(data_dir=self.path)
        self.backend = FakeDesktop()
        self.manager = self.app.state.desktop
        self.manager.backend = self.backend
        token, self.device = self.app.state.device_store.exchange(self.app.state.device_store.issue_pairing_code(), 'test')
        self.auth = {'authorization': f'Bearer {token}'}
        self.client = TestClient(self.app)

    def test_remote_cannot_enable_or_read_credentials_without_auth(self):
        for path in ['/remote/desktop/status', '/remote/desktop/ice']:
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post('/remote/desktop/enabled', headers=self.auth, json={'enabled': True}).status_code, 405)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.client.get('/remote/desktop/ice', headers=self.auth).status_code, 409)

    def test_local_management_csrf_host_and_forwarding(self):
        client = TestClient(create_management_app(self.manager), base_url='http://127.0.0.1:8767')
        page = client.get('/')
        self.assertEqual(page.status_code, 200)
        token = re.search("const token = '([^']+)'", page.text)[1]
        headers = {'origin': 'http://127.0.0.1:8767', 'x-desktop-csrf': token}
        for bad in [{}, {**headers, 'origin': 'https://evil.test'}, {**headers, 'x-forwarded-for': '127.0.0.1'}, {**headers, 'host': 'evil.test'}, {**headers, 'sec-fetch-site': 'cross-site'}]:
            self.assertEqual(client.post('/enabled', json={'enabled': True}, headers=bad).status_code, 403)
        self.assertEqual(client.post('/enabled', headers=headers, json={'enabled': True}).status_code, 200)
        self.assertTrue(DesktopManager(self.path, self.app.state.device_store, self.backend).enabled)
        self.assertEqual(client.post('/enabled', headers=headers, json={'enabled': 'yes'}).status_code, 422)
        self.assertEqual(client.post('/enabled', headers=headers, json={'enabled': False}).status_code, 200)

    def test_permissions_and_lock_fail_closed(self):
        self.manager.enabled = True
        for field in self.backend.flags:
            self.backend.flags[field] = False
            self.assertEqual(self.client.get('/remote/desktop/ice', headers=self.auth).status_code, 409)
            self.backend.flags[field] = True

    def test_revoke_and_logout_stop_existing_peer(self):
        for route in ('revoke', 'logout'):
            code = self.app.state.device_store.issue_pairing_code()
            token, device = self.app.state.device_store.exchange(code, 'test')
            peer = Mock(close=AsyncMock())
            session = DesktopSession(self.manager, device['device_id'], peer)
            self.manager.session = session
            auth = {'authorization': f'Bearer {token}'}
            response = (self.client.delete(f"/remote/devices/{device['device_id']}", headers=auth)
                        if route == 'revoke' else self.client.post('/remote/logout', headers=auth))
            self.assertEqual(response.status_code, 200)
            self.assertTrue(session.closed)
            self.assertIsNone(self.manager.session)
            peer.close.assert_awaited_once()

    def test_service_start_does_not_wait_for_desktop_media(self):
        # Consumer only allows 30s startup; cold frozen media exceeded 50s on
        # macOS14. Keep optional media off the core listener startup path.
        import importlib
        module = importlib.import_module('server.app')
        with patch('server.desktop.load_media') as media, \
             patch.object(module.TunnelSettings, 'from_env', return_value=None), \
             patch.object(module.uvicorn, 'run') as run:
            module.main(['serve'])
        media.assert_not_called()
        run.assert_called_once()

    def test_diagnostics_are_local_only_and_contain_counts_not_input(self):
        peer = Mock(close=AsyncMock())
        session = DesktopSession(self.manager, self.device['device_id'], peer)
        session.channel = Mock()
        self.manager.session = session
        self.manager.enabled = True
        fields = handshake(session)
        session.message(json.dumps({**fields, 'type': 'text', 'text': 'private-test-content', 'seq': 1}))
        client = TestClient(create_management_app(self.manager), base_url='http://127.0.0.1:8767')
        result = client.get('/diagnostics')
        self.assertEqual(result.json()['input']['accepted'], 1)
        self.assertNotIn('private-test-content', result.text)
        self.assertNotIn(fields['ticket'], result.text)
        self.assertEqual(client.get('/diagnostics', headers={'x-forwarded-for': '127.0.0.1'}).status_code, 403)
        remote = self.client.get('/remote/desktop/diagnostics', headers=self.auth)
        self.assertNotIn('native_errors', remote.text)

    def test_turn_short_lived(self):
        env = {'HAISH_DESKTOP_TURN_URLS': 'turn:relay.test:3478,turns:relay.test:5349', 'HAISH_DESKTOP_TURN_SECRET': 'test-only-secret'}
        servers, configured = ice_servers(env, now=100, subject='paired')
        self.assertTrue(configured)
        self.assertEqual(servers[0]['username'], '700:paired')
        self.assertNotIn(env['HAISH_DESKTOP_TURN_SECRET'], json.dumps(servers))
        self.assertEqual(ice_servers({}), ([], False))

    def test_input_validation(self):
        for m in [None, {}, {'type': 'text', 'text': 'x'*1025}, {'type': 'move', 'dx': float('nan'), 'dy': 0}, {'type': 'key', 'key': 'invalid', 'down': True}, {'type': 'button', 'button': 'left', 'down': 1}]:
            self.assertFalse(validate_input(m))
        self.assertTrue(validate_input({'type': 'text', 'text': '中文😀'}))


def handshake(session, generation=0):
    session.message(json.dumps({'type': 'ping', 'generation': generation, 'probe': 'test-probe'}))
    response = json.loads(session.channel.send.call_args.args[0])
    assert response['type'] == 'challenge'
    session.message(json.dumps({**response, 'type': 'resume'}))
    return {k: response[k] for k in ('generation', 'epoch', 'ticket')}


class FreshnessTests(unittest.TestCase):
    def session(self):
        backend = Mock()
        manager = Mock(backend=backend)
        manager.authorized.return_value = True
        s = DesktopSession(manager, 'test', Mock())
        s.channel = Mock()
        return s, backend

    def test_delayed_input_before_and_after_returning_ping(self):
        for gap in (2, 2.5, 3, 8):
            for returning_ping in (False, True):
                with self.subTest(gap=gap, returning_ping=returning_ping):
                    with patch('server.desktop.time.monotonic', return_value=100):
                        s, backend = self.session()
                        old = handshake(s)
                        s.message(json.dumps({**old, 'type': 'key', 'key': 'Cmd', 'down': True, 'seq': 1}))
                        backend.input.assert_called_once()
                    with patch('server.desktop.time.monotonic', return_value=100+gap):
                        if returning_ping:
                            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'old-ping'}))
                        s.message(json.dumps({**old, 'type': 'text', 'text': 'stale', 'seq': 2}))
                        self.assertEqual(backend.input.call_count, 1)
                        self.assertNotEqual(s.epoch, old['epoch'])
                        self.assertFalse(s.active())
                        self.assertGreater(backend.release.call_count, 0)
                        fresh = handshake(s, generation=1)
                        self.assertTrue(s.active())
                        s.message(json.dumps({**old, 'type': 'key', 'key': 'Cmd', 'down': True, 'seq': 3}))
                        self.assertEqual(backend.input.call_count, 1)
                        s.message(json.dumps({**fresh, 'type': 'text', 'text': 'fresh', 'seq': 1}))
                        self.assertEqual(backend.input.call_count, 2)

    def test_old_ticket_expires_even_when_heartbeats_stay_live(self):
        with patch('server.desktop.time.monotonic', return_value=100):
            s, backend = self.session()
            old = handshake(s)
        for now in (100.5, 100.9, 101.3):
            with patch('server.desktop.time.monotonic', return_value=now):
                s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': str(now)}))
        with patch('server.desktop.time.monotonic', return_value=101.4):
            self.assertTrue(s.active())
            s.message(json.dumps({**old, 'type': 'text', 'text': 'delayed', 'seq': 1}))
            backend.input.assert_not_called()
            ready = json.loads(s.channel.send.call_args.args[0])
            s.message(json.dumps({**ready, 'type': 'text', 'text': 'new', 'seq': 2}))
            backend.input.assert_called_once()

    def test_stale_ping_and_resume_do_not_arm_input(self):
        with patch('server.desktop.time.monotonic', return_value=100):
            s, backend = self.session()
            old = handshake(s)
        with patch('server.desktop.time.monotonic', return_value=102.5):
            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'delayed-ping'}))
            self.assertFalse(s.active())
            s.message(json.dumps({**old, 'type': 'resume', 'probe': 'old-resume'}))
            self.assertFalse(s.active())
            fresh = handshake(s, generation=1)
            epoch = s.epoch
            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'older-generation'}))
            self.assertEqual(s.epoch, epoch)
            s.message(json.dumps({**fresh, 'type': 'text', 'text': 'new', 'seq': 1}))
            backend.input.assert_called_once()

    def test_lost_resume_ack_reissues_challenge_and_invalidates_old_ticket(self):
        with patch('server.desktop.time.monotonic', return_value=100):
            s, backend = self.session()
            old = handshake(s)
        with patch('server.desktop.time.monotonic', return_value=100.5):
            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'retry', 'paused': True}))
            challenge = json.loads(s.channel.send.call_args.args[0])
            self.assertEqual(challenge['type'], 'challenge')
            self.assertFalse(s.active())
            s.message(json.dumps({**old, 'type': 'text', 'text': 'old', 'seq': 1}))
            backend.input.assert_not_called()
            s.message(json.dumps({**challenge, 'type': 'resume'}))
            self.assertTrue(s.active())
            s.message(json.dumps({**challenge, 'type': 'text', 'text': 'new', 'seq': 1}))
            backend.input.assert_called_once()

    def test_lost_key_up_is_released_without_replaying_missing_down(self):
        with patch('server.desktop.time.monotonic', return_value=100):
            s, backend = self.session()
            fresh = handshake(s)
            s.message(json.dumps({**fresh, 'type': 'key', 'key': 'Cmd', 'down': True, 'seq': 1}))
            s.message(json.dumps({**fresh, 'type': 'button', 'button': 'left', 'down': True, 'seq': 2}))
        with patch('server.desktop.time.monotonic', return_value=100.5):
            # up packets were lost: heartbeat advertises empty state, must release.
            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'p2', 'heldKeys': [], 'heldButtons': []}))
            self.assertIn(unittest.mock.call({'type': 'key', 'key': 'Cmd', 'down': False}), backend.input.call_args_list)
            self.assertIn(unittest.mock.call({'type': 'button', 'button': 'left', 'down': False}), backend.input.call_args_list)
            count = backend.input.call_count
            # The opposite (missing down) must never be synthesized from a ping.
            s.message(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'p3', 'heldKeys': ['Option']}))
            self.assertEqual(backend.input.call_count, count)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = DeviceStore(Path(self.temp.name)/'store.sqlite3')
        _, self.device = self.store.exchange(self.store.issue_pairing_code(), 'test')
        self.backend = FakeDesktop()
        self.manager = DesktopManager(Path(self.temp.name), self.store, self.backend)
        self.manager.enabled = True

    async def test_epochs_revoke_and_disable(self):
        class Peer:
            async def close(self):
                pass
        s = DesktopSession(self.manager, self.device['device_id'], Peer())
        self.manager.session = s
        s.channel = Mock()
        fields = handshake(s)
        command = {**fields, 'type': 'key', 'key': 'Cmd', 'down': True, 'seq': 1}
        s.message(json.dumps(command))
        self.assertEqual(len(self.backend.inputs), 1)
        s.message(json.dumps(command))
        self.assertEqual(len(self.backend.inputs), 1)
        s.suspend()
        handshake(s, generation=1)
        s.message(json.dumps({**command, 'seq': 2}))
        self.assertEqual(len(self.backend.inputs), 1)
        self.store.revoke(self.device['device_id'])
        s.message(json.dumps({**command, 'epoch': s.epoch, 'seq': 3}))
        await asyncio.sleep(0)
        self.assertTrue(s.closed)
        self.assertGreater(self.backend.releases, 0)
        # Closing is a shielded session-owned task, not necessarily one loop turn.
        await asyncio.wait_for(self.manager.stop(session=s), 1)
        self.assertIsNone(self.manager.session)

    async def test_real_webrtc_fake_video_busy_and_cleanup(self):
        try:
            from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration
        except ImportError:
            self.skipTest('Install adapter dependencies for media integration')
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.addAsyncCleanup(pc.close)
        self.addAsyncCleanup(self.manager.stop)
        pc.addTransceiver('video', direction='recvonly')
        channel = pc.createDataChannel('input', ordered=True, maxPacketLifeTime=250)
        ready = asyncio.Event()
        frames = asyncio.Event()
        responses = []
        @channel.on('open')
        def opened():
            channel.send(json.dumps({'type': 'ping', 'generation': 0, 'probe': 'integration'}))
        @channel.on('message')
        def message(raw):
            data = json.loads(raw)
            if data['type'] == 'challenge':
                channel.send(json.dumps({**data, 'type': 'resume'}))
            elif data['type'] == 'ready':
                responses.append(data)
                ready.set()
        @pc.on('track')
        def track_received(track):
            async def receive():
                await track.recv()
                frames.set()
            asyncio.create_task(receive())
        await pc.setLocalDescription(await pc.createOffer())
        answer = await self.manager.offer(self.device['device_id'], pc.localDescription.sdp)
        with self.assertRaises(HTTPException) as busy:
            await self.manager.offer('second', pc.localDescription.sdp)
        self.assertEqual(busy.exception.status_code, 409)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'], type='answer'))
        await asyncio.wait_for(ready.wait(), 5)
        await asyncio.wait_for(frames.wait(), 5)
        old = responses[-1]
        channel.send(json.dumps({**old, 'type': 'text', 'text': 'initial', 'seq': 1}))
        await asyncio.sleep(.05)
        self.assertEqual([m.get('text') for m in self.backend.inputs], ['initial'])
        # Real SCTP/DTLS with an application heartbeat gap (not physical loss).
        # Even if a transport delivers old packets, authorization must reject.
        await asyncio.sleep(1.1)
        count = len(self.backend.inputs)
        channel.send(json.dumps({**old, 'type': 'text', 'text': 'stale-before-ping', 'seq': 2}))
        ready.clear()
        channel.send(json.dumps({'type': 'ping', 'generation': 1, 'probe': 'integration-recovery'}))
        await asyncio.wait_for(ready.wait(), 5)
        fresh = responses[-1]
        self.assertNotEqual(old['epoch'], fresh['epoch'])
        channel.send(json.dumps({**old, 'type': 'text', 'text': 'stale-after-resume', 'seq': 3}))
        channel.send(json.dumps({**fresh, 'type': 'text', 'text': 'recovered', 'seq': 1}))
        await asyncio.sleep(.05)
        self.assertEqual(len(self.backend.inputs), count+1)
        self.assertEqual(self.backend.inputs[-1]['text'], 'recovered')
        await self.manager.set_enabled(False)
        self.assertIsNone(self.manager.session)
        self.assertGreater(self.backend.releases, 0)

    async def test_cold_media_import_does_not_block_disable(self):
        import threading
        started = threading.Event()
        finish = threading.Event()

        def cold_import():
            started.set()
            finish.wait(2)
            return (Mock(),) * 5

        with patch('server.desktop.load_media', side_effect=cold_import):
            offer = asyncio.create_task(self.manager.offer(self.device['device_id'], 'cold'))
            try:
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(.001)
                self.assertTrue(started.is_set())
                await asyncio.wait_for(self.manager.set_enabled(False), .5)
                self.assertIsNone(self.manager.session)
                finish.set()
                with self.assertRaises(HTTPException) as error:
                    await asyncio.wait_for(offer, 1)
                self.assertEqual(error.exception.status_code, 409)
            finally:
                finish.set()
                if not offer.done():
                    offer.cancel()

    async def test_frozen_enabled_lifespan_does_not_join_warmup(self):
        import importlib
        module=importlib.import_module('server.app')
        app=create_app(data_dir=Path(self.temp.name))
        app.state.desktop.backend=self.backend
        app.state.desktop.enabled=True
        with patch.object(module.sys,'frozen',True,create=True), patch.object(app.state.desktop,'warm_media') as warm:
            async with asyncio.timeout(.2):
                async with module._lifespan(app):
                    warm.assert_called_once()
                    self.assertIsNone(app.state.desktop.session)
        app.state.desktop.enabled=False
        with patch.object(module.sys,'frozen',True,create=True), patch.object(app.state.desktop,'warm_media') as warm:
            async with module._lifespan(app):warm.assert_not_called()

    async def test_media_timeout_preserves_shared_warmup(self):
        import threading
        started, finish = threading.Event(), threading.Event()
        def cold():
            started.set()
            finish.wait(2)
            return (Mock(),) * 5
        with patch('server.desktop.load_media', side_effect=cold) as media, patch('server.desktop.NEGOTIATION_SECONDS', .03):
            try:
                await self.manager.set_enabled(True)
                task = self.manager.media_task
                with self.assertRaises(HTTPException) as error:
                    await self.manager.offer(self.device['device_id'], 'cold')
                self.assertEqual(error.exception.status_code,503)
                self.assertFalse(task.done())
                self.assertEqual(self.manager.media_diagnostics.snapshot()['state'], 'loading')
                self.assertEqual(self.manager.media_diagnostics.snapshot()['attempt'], 1)
                self.assertIs(self.manager.warm_media(),task)
                await self.manager.set_enabled(False)
                self.assertIsNone(self.manager.session)
                finish.set()
                await asyncio.wait_for(task,1)
                self.assertEqual(self.manager.media_diagnostics.snapshot()['state'], 'ready')
                self.assertEqual(self.manager.media_diagnostics.snapshot()['attempt'], 1)
                media.assert_called_once()
                self.assertEqual(self.backend.inputs,[])
            finally:
                finish.set()

    async def test_remote_description_timeout_releases_slot(self):
        entered = asyncio.Event()
        peer = Mock()
        peer.close = AsyncMock()

        async def blocked_remote_description(_):
            entered.set()
            await asyncio.Event().wait()

        peer.setRemoteDescription = blocked_remote_description
        with patch('aiortc.RTCPeerConnection', return_value=peer), patch('server.desktop.NEGOTIATION_SECONDS', .05):
            with self.assertRaises(HTTPException) as error:
                await asyncio.wait_for(self.manager.offer(self.device['device_id'], 'blocked-mdns'), 1)
        self.assertTrue(entered.is_set())
        self.assertEqual(error.exception.status_code, 503)
        self.assertIsNone(self.manager.session)
        peer.close.assert_awaited_once()

    async def test_cancelled_stop_keeps_peer_cleanup_alive(self):
        class Peer:
            def __init__(self):
                self.started = asyncio.Event()
                self.finish = asyncio.Event()
                self.calls = 0
                self.cancelled = False

            async def close(self):
                self.calls += 1
                self.started.set()
                try:
                    await self.finish.wait()
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise

        peer = Peer()
        s = DesktopSession(self.manager, self.device['device_id'], peer)
        self.manager.session = s
        stop = asyncio.create_task(self.manager.stop())
        await peer.started.wait()
        stop.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await stop
        self.assertTrue(s.closed)
        self.assertFalse(peer.cancelled)
        self.assertIs(self.manager.session, s)  # no overlap while cleanup runs
        another_stop = asyncio.create_task(self.manager.stop())
        peer.finish.set()
        await asyncio.wait_for(another_stop, 1)
        self.assertEqual(peer.calls, 1)
        self.assertIsNone(self.manager.session)

    async def test_disable_joins_watchdog_cleanup_without_cancelling_peer(self):
        peer = Mock(close=AsyncMock())
        entered = asyncio.Event()
        finish = asyncio.Event()

        async def close():
            entered.set()
            await finish.wait()

        peer.close.side_effect = close
        s = DesktopSession(self.manager, self.device['device_id'], peer)
        self.manager.session = s
        s.watchdog = asyncio.create_task(self.manager.stop(session=s))
        await entered.wait()
        disable = asyncio.create_task(self.manager.set_enabled(False))
        await asyncio.sleep(0)
        finish.set()
        await asyncio.wait_for(disable, 1)
        await s.watchdog
        peer.close.assert_awaited_once()
        self.assertIsNone(self.manager.session)
        self.assertFalse(self.manager.enabled)

    async def test_permission_loss_stops_active_session(self):
        class Peer:
            async def close(self):
                pass
        s = DesktopSession(self.manager, self.device['device_id'], Peer())
        self.manager.session = s
        s.watchdog = asyncio.create_task(s.watch())
        self.backend.flags['accessibility'] = False
        await asyncio.sleep(.35)
        self.assertTrue(s.closed)
        self.assertIsNone(self.manager.session)
