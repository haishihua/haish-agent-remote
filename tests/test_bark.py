import asyncio
import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from server.app import DeviceStore, create_app
from server.bark import BarkService, all_tasks, request_preview, timestamp


class BarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.store = DeviceStore(self.path / 'remote.sqlite3')
        self.token, self.device = self.store.exchange(self.store.issue_pairing_code(), 'Phone')
        self.service = BarkService(self.store, lambda: 'http://runtime.test', lambda: 'https://haish.example')
        self.service.configure(self.device['device_id'], 'test-device-key')
        self.sent = []

    def tearDown(self):
        self.temp.cleanup()

    def task(self, status='done', **extra):
        return {'task_id': 'task-1', 'conversation_id': 'conversation-1', 'status': status,
                'title': 'Fix uploads', 'completed_at': time.time() + 1, **extra}

    def states(self):
        with self.store._connect() as db:
            return {r['task_id']: dict(r) for r in db.execute('SELECT * FROM bark_deliveries')}

    def deliver(self, status=200, result=None, error=False):
        def handler(request):
            self.sent.append(request)
            if error:
                raise httpx.ReadTimeout('transport', request=request)
            return httpx.Response(status, json=result if result is not None else {'code': 200})
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                await self.service.deliver(client)
        asyncio.run(run())

    def due(self):
        with self.store._connect() as db:
            db.execute('UPDATE bark_deliveries SET next_attempt = 0')

    def test_all_desktop_and_phone_tasks_between_polls_and_restart_dedup(self):
        snapshot = {'projects': [{'conversations': [{'conversation_id': 'conversation-1', 'tasks': [
            self.task(task_id='desktop-1'), self.task(task_id='phone-1', status='failed', title='Review diff')]}]}]}
        self.service.observe(list(all_tasks(snapshot)))
        self.deliver()
        self.assertEqual(len(self.sent), 2)
        self.service = BarkService(self.store, lambda: 'http://runtime.test', lambda: 'https://haish.example')
        self.service.observe(list(all_tasks(snapshot)))
        self.deliver()
        self.assertEqual(len(self.sent), 2)
        payloads = [json.loads(r.content) for r in self.sent]
        self.assertEqual([p['title'] for p in payloads], ['Task completed', 'Task failed'])
        self.assertEqual([p['body'] for p in payloads], ['Fix uploads', 'Review diff'])
        self.assertTrue(all(r.url == 'https://api.day.app/push' for r in self.sent))
        self.assertTrue(all(p['icon'] == 'https://haish.example/remote/notification-icon.png' for p in payloads))
        self.assertTrue(all(p['url'].startswith('haish://conversation/conversation-1?device=') for p in payloads))
        self.assertTrue(all('test-device-key' not in str(r.url) for r in self.sent))
        self.assertTrue(all(r['body'] == '' for r in self.states().values()))

    def test_history_suppression_active_transition_and_sparse_body(self):
        self.service.observe([self.task(task_id='old', completed_at=1), self.task('running', completed_at=None)])
        self.service.observe([self.task(title=None, completed_at=None)])
        self.deliver()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(json.loads(self.sent[0].content)['body'], 'Fix uploads')
        self.assertEqual(self.states()['old']['state'], 'ignored')

    def test_waiting_input_remains_eligible_and_empty_display_does_not_restore_private_preview(self):
        self.service.observe([self.task('running', display_text='Visible request')])
        self.service.observe([self.task('waiting_input', completed_at=None, display_text='')])
        self.service.observe([self.task(completed_at=None, display_text='')])
        self.deliver()
        self.assertEqual(json.loads(self.sent[0].content)['body'], 'Task request')

    def test_cancellation_and_unknown_transport_state_are_not_failures(self):
        self.service.observe([self.task('running')])
        self.service.observe([self.task('cancelled'), self.task('stream-read', task_id='transport')])
        self.deliver()
        self.assertEqual(self.sent, [])

    def test_transient_retry_and_permanent_rejection(self):
        self.service.observe([self.task()])
        self.deliver(status=503)
        self.assertEqual(self.states()['task-1']['state'], 'pending')
        self.deliver()
        self.assertEqual(len(self.sent), 1)
        self.due()
        self.deliver()
        self.assertEqual(self.states()['task-1']['state'], 'sent')
        self.service.observe([self.task(task_id='invalid')])
        self.deliver(result={'code': 400, 'message': 'private response'})
        self.assertEqual(self.states()['invalid']['state'], 'failed')
        self.assertNotIn('private response', str(self.states()))

    def test_ambiguous_timeout_retries_with_bounded_attempts(self):
        self.service.observe([self.task()])
        for _ in range(8):
            self.due()
            self.deliver(error=True)
        self.assertEqual(self.states()['task-1']['state'], 'failed')
        self.assertEqual(self.states()['task-1']['attempts'], 8)

    def test_disable_and_device_revocation_stop_pending_delivery(self):
        self.service.observe([self.task()])
        self.service.disable(self.device['device_id'])
        self.deliver()
        self.assertEqual(self.sent, [])
        self.service.configure(self.device['device_id'], 'test-device-key')
        self.service.observe([self.task(task_id='new')])
        self.store.revoke(self.device['device_id'])
        self.deliver()
        self.assertEqual(self.sent, [])

    def test_replace_key_cancels_queue_without_replaying_history(self):
        self.service.observe([self.task('running'), self.task(task_id='pending')])
        self.service.configure(self.device['device_id'], 'replacement-key')
        self.service.observe([self.task(completed_at=1), self.task(task_id='pending', completed_at=1)])
        self.deliver()
        self.assertEqual(self.sent, [])
        self.service.observe([self.task('running', completed_at=None)])
        # Replaced generation's old ignored task remains historical in this snapshot.
        self.assertEqual(self.states()['task-1']['state'], 'ignored')

    def test_same_key_save_is_idempotent_and_secure_permissions(self):
        self.service.observe([self.task()])
        self.service.configure(self.device['device_id'], 'test-device-key')
        self.deliver()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('test-device-key', json.dumps(self.service.status(self.device['device_id'])))

    def test_preview_sanitization(self):
        augmentation = '[user attached image #1: /private/image.png]\nThe user attached the image(s) above. Inspect the image files before answering;'
        self.assertEqual(request_preview({'title': f'Check this\n{augmentation}'}), 'Check this')
        self.assertEqual(request_preview({'title': augmentation}), 'Task request')
        self.assertEqual(request_preview({'display_text': '', 'title': 'Quoted feedback secret'}), 'Task request')
        self.assertEqual(request_preview({'title': 'Check\n[user attached image #1: /secret/'}), 'Check')
        self.assertEqual(len(request_preview({'title': 'x' * 1000})), 160)
        self.assertEqual(timestamp('1970-01-01T00:00:10Z'), 10)

    def test_api_auth_secrets_revocation_and_public_icon(self):
        app = create_app(data_dir=self.path, dist_dir=self.path)
        client = TestClient(app)
        headers = {'Authorization': f'Bearer {self.token}'}
        route = '/remote/notifications/bark'
        self.assertEqual(client.put(route, json={'device_key': 'anything'}).status_code, 401)
        secret = 'https://private.test/secret-value'
        response = client.put(route, json={'device_key': secret}, headers=headers)
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(secret, response.text)
        response = client.put(route, json={'device_key': 'test-device-key'}, headers=headers)
        self.assertTrue(response.json()['enabled'])
        self.assertNotIn('test-device-key', client.get(route, headers=headers).text)
        icon = client.get('/remote/notification-icon.png')
        self.assertEqual(icon.status_code, 200)
        self.assertEqual(icon.headers['content-type'], 'image/png')
        self.assertTrue(icon.content.startswith(b'\x89PNG'))
        client.post('/remote/logout', headers=headers)
        self.assertFalse(app.state.bark.status(self.device['device_id'])['enabled'])
        self.assertEqual(client.get(route, headers=headers).status_code, 401)

    def test_two_subscribers_have_independent_delivery_and_revocation(self):
        _, other = self.store.exchange(self.store.issue_pairing_code(), 'Other phone')
        self.service.configure(other['device_id'], 'other-device-key')
        self.service.observe([self.task()])
        self.store.revoke(self.device['device_id'])
        self.deliver()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(json.loads(self.sent[0].content)['device_key'], 'other-device-key')

    def test_lifespan_starts_and_cancels_watcher(self):
        app = create_app(data_dir=self.path, dist_dir=self.path)
        started = False
        stopped = False
        async def worker():
            nonlocal started, stopped
            started = True
            try:
                await asyncio.Event().wait()
            finally:
                stopped = True
        with patch.object(app.state.bark, 'run', side_effect=worker):
            with TestClient(app) as client:
                self.assertEqual(client.get('/remote/notifications/bark', headers={'Authorization': f'Bearer {self.token}'}).status_code, 200)
                self.assertTrue(started)
            self.assertTrue(stopped)

    def test_background_watcher_uses_full_runtime_feed_and_retries_when_runtime_offline(self):
        requests = []
        snapshot = {'projects': [{'conversations': [{'conversation_id': 'conversation-1', 'tasks': [self.task()]}]}]}
        def handler(request):
            requests.append(request)
            if request.method == 'GET':
                return httpx.Response(200, json=snapshot)
            return httpx.Response(200, json={'code': 200})
        original = httpx.AsyncClient
        async def stop(_seconds):
            raise asyncio.CancelledError()
        async def run():
            with patch('server.bark.httpx.AsyncClient', side_effect=lambda **kw: original(transport=httpx.MockTransport(handler), **kw)), patch('server.bark.asyncio.sleep', side_effect=stop):
                with self.assertRaises(asyncio.CancelledError):
                    await self.service.run()
        asyncio.run(run())
        self.assertIn('summary_only=false', str(requests[0].url))
        self.assertEqual([r.method for r in requests], ['GET', 'POST'])
        self.assertEqual(self.states()['task-1']['state'], 'sent')
        self.service.observe([self.task(task_id='offline-pending')])
        self.service.discover_upstream = lambda: (_ for _ in ()).throw(RuntimeError('offline'))
        asyncio.run(run())
        self.assertEqual(self.states()['offline-pending']['state'], 'sent')


if __name__ == '__main__':
    unittest.main()
