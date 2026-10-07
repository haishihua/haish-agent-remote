import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from server.media_diagnostics import MediaDiagnostics, observe_native_loads, record_native_load, media_stage
from server.desktop import DesktopManager
from server.desktop_management import create_management_app


class DiagnosticsTests(unittest.TestCase):
    def test_stage_duration_failure_reset_and_snapshot_copy(self):
        now = [10.0]
        d = MediaDiagnostics(lambda: now[0])
        self.assertEqual(d.snapshot()['state'], 'idle')
        self.assertIsNone(d.snapshot()['elapsed_seconds'])
        d.begin()
        with self.assertRaises(ImportError), d.stage('av_import'):
            now[0] = 12
            self.assertEqual(d.snapshot()['phase_elapsed_seconds'], 2)
            raise ImportError('private path or credential must not be retained')
        d.end(False)
        now[0] = 20
        s = d.snapshot()
        self.assertEqual(s['elapsed_seconds'], 2)
        self.assertEqual(s['phases_seconds'], {'av_import': 2})
        self.assertEqual(s['state'], 'failed')
        self.assertNotIn('private', json.dumps(s))
        s['phases_seconds']['av_import'] = 99
        self.assertEqual(d.snapshot()['phases_seconds']['av_import'], 2)
        d.begin()
        self.assertEqual(d.snapshot()['attempt'], 2)
        self.assertEqual(d.snapshot()['phases_seconds'], {})

    def test_observer_is_thread_local_restored_and_bounded(self):
        d = MediaDiagnostics()
        d.begin()
        with observe_native_loads(d), media_stage('av_import'):
            record_native_load('av._core', 2.0)
            record_native_load('av.video.frame', 1.0)
            record_native_load('/private/secret-user-path', .5)
            thread = threading.Thread(target=lambda: record_native_load('av.not_observed', 99))
            thread.start(); thread.join()
            with observe_native_loads(None):
                record_native_load('av.not_observed', 99)
        record_native_load('av.not_observed', 99)
        s = d.snapshot()
        self.assertEqual(s['native_groups']['av'], {'count': 2, 'seconds': 3.0, 'max_seconds': 2.0})
        self.assertEqual(set(s['native_groups']), {'av', 'other'})
        self.assertNotIn('secret', json.dumps(s))
        self.assertIsNone(s['phase'])

    def test_load_media_reports_each_fixed_phase(self):
        from server.desktop import load_media
        d = MediaDiagnostics()
        d.begin()
        with observe_native_loads(d):
            result = load_media()
        d.end(True)
        self.assertEqual(len(result), 5)
        self.assertEqual(set(d.snapshot()['phases_seconds']), {'loader_setup', 'av_import', 'aiortc_import'})
        self.assertIsNone(d.snapshot()['phase'])

    def test_management_diagnostics_remains_loopback_only(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DesktopManager(Path(directory), None)
            app = create_management_app(manager, 19767)
            with TestClient(app, base_url='http://127.0.0.1:19767') as client:
                data = client.get('/diagnostics').json()
                self.assertEqual(data['media']['state'], 'idle')
                self.assertEqual(client.get('/diagnostics', headers={'Origin':'https://external.example'}).status_code, 403)
                self.assertEqual(client.get('/diagnostics', headers={'X-Forwarded-For':'127.0.0.1'}).status_code, 403)
                self.assertEqual(client.get('/diagnostics', headers={'Host':'external.example'}).status_code, 403)


class LoadDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_failure_retry_share_task_and_do_not_retain_error(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DesktopManager(Path(directory), None)
            def fail():
                record_native_load('av._core', .3)
                raise ImportError('sensitive-error')
            with patch('server.desktop.load_media', side_effect=fail):
                with self.assertRaises(ImportError):
                    await manager.warm_media()
            self.assertEqual(manager.media_diagnostics.snapshot()['state'], 'failed')
            with patch('server.desktop.load_media', return_value=('media',)) as load:
                a = manager.warm_media()
                self.assertIs(a, manager.warm_media())
                self.assertEqual(await a, ('media',))
                load.assert_called_once()
            snapshot = manager.media_diagnostics.snapshot()
            self.assertEqual(snapshot['state'], 'ready')
            self.assertEqual(snapshot['attempt'], 2)
            self.assertNotIn('sensitive', json.dumps(snapshot))
