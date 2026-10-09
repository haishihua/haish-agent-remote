import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from server.desktop import ice_servers
from server.desktop_ice import turn_settings, turn_configured


class PersistentIceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'desktop-turn.json'
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def configure(self, config=None, mode=0o600):
        self.path.write_text(json.dumps(config or {'urls': ['turn:example.com:3478'], 'secret': 'private-test-secret'}))
        self.path.chmod(mode)

    def test_absent_config_remains_direct_only(self):
        self.assertEqual(turn_settings(self.root), ([], ''))
        self.assertFalse(turn_configured(self.root))

    def test_private_config_generates_short_lived_credentials(self):
        self.configure()
        servers, configured = ice_servers(data_dir=self.root, now=100, subject='device')
        self.assertTrue(configured)
        self.assertTrue(turn_configured(self.root))
        self.assertEqual(servers[0]['username'], '700:device')
        expected = base64.b64encode(hmac.new(b'private-test-secret', b'700:device', hashlib.sha1).digest()).decode()
        self.assertEqual(servers[0]['credential'], expected)
        self.assertNotIn('private-test-secret', json.dumps(servers))

    def test_environment_has_explicit_precedence(self):
        self.configure()
        self.assertEqual(turn_settings(self.root, {'HAISH_DESKTOP_TURN_URLS': ''}), ([], ''))
        self.assertEqual(turn_settings(self.root, {'HAISH_DESKTOP_TURN_URLS': 'turn:other:3478',
                                                 'HAISH_DESKTOP_TURN_SECRET': 'other'}), (['turn:other:3478'], 'other'))

    def test_insecure_permissions_and_malformed_file_fail_closed(self):
        self.configure(mode=0o644)
        with self.assertRaises(HTTPException):
            turn_settings(self.root)
        self.assertFalse(turn_configured(self.root))
        self.path.chmod(0o600)
        for raw in ('{', '[]', 'null'):
            self.path.write_text(raw)
            with self.assertRaises(HTTPException):
                turn_settings(self.root)

    def test_unsafe_urls_or_secret_fail_closed(self):
        for config in ({'urls': ['turn:user@host'], 'secret': 'x'},
                       {'urls': ['https://host'], 'secret': 'x'},
                       {'urls': ['turn:host\n'], 'secret': 'x'},
                       {'urls': [1], 'secret': 'x'},
                       {'urls': ['turn:host'], 'secret': 1}):
            self.configure(config)
            with self.assertRaises(HTTPException):
                turn_settings(self.root)

    def test_default_data_directory_from_environment(self):
        self.configure()
        with patch.dict(os.environ, {'HAISH_REMOTE_DATA_DIR': str(self.root)}):
            self.assertTrue(turn_configured())


if __name__ == '__main__':
    unittest.main()
