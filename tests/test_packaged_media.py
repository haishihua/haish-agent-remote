import importlib.machinery
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch, Mock

from server import packaged_media as media


class PackagedMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'av').mkdir()
        (self.root / 'av/_native.so').write_bytes(b'test')
        self.payload = {'schema': 1, 'version': '16.1.0', 'modules': {'av.video.frame': 'haish_av_video_frame'}}
        self.manifest = self.root / 'av/native-modules.json'
        self.manifest.write_text(json.dumps(self.payload))
        self.path = list(sys.meta_path)
        self.previous = media._installed
        media._installed = False
        self.patches = [patch.object(sys, 'frozen', True, create=True), patch.object(sys, '_MEIPASS', str(self.root), create=True), patch.object(sys, 'platform', 'darwin')]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        sys.meta_path[:] = self.path
        media._installed = self.previous
        self.temp.cleanup()

    def test_register_only_idempotent_and_no_foreign_names(self):
        with patch.object(media.ctypes, 'CDLL', side_effect=AssertionError('must not load during registration')):
            threads = [threading.Thread(target=media.install_packaged_media) for _ in range(10)]
            for t in threads: t.start()
            for t in threads: t.join()
        self.assertEqual(sum(isinstance(f, media._NativeFinder) for f in sys.meta_path), 1)
        finder = sys.meta_path[0]
        self.assertIsNone(finder.find_spec('server.app'))
        self.assertIsNone(finder.find_spec('av.unknown'))
        spec = finder.find_spec('av.video.frame')
        self.assertEqual(spec.name, 'av.video.frame')
        self.assertEqual(spec.loader.entrypoint, 'haish_av_video_frame')

    def test_source_and_legacy_build_are_unchanged(self):
        with patch.object(sys, 'frozen', False): media.install_packaged_media()
        self.assertFalse(media._installed)
        self.manifest.unlink()
        media.install_packaged_media()
        self.assertEqual(sys.meta_path, self.path)

    def test_invalid_manifest_and_image_fail_closed(self):
        for payload in [[], {'schema': 2}, dict(self.payload, version='17'), dict(self.payload, modules={}), dict(self.payload, modules={'os': 'haish_os'}), dict(self.payload, modules={'av.frame': '../escape'}), dict(self.payload, modules={'av.frame': None})]:
            self.manifest.write_text(json.dumps(payload))
            with self.assertRaises((ImportError, AttributeError)): media.install_packaged_media()
            self.assertFalse(media._installed)
            self.assertEqual(sys.meta_path, self.path)
        self.manifest.write_text(json.dumps(self.payload))
        (self.root / 'av/_native.so').unlink()
        with self.assertRaises(ImportError): media.install_packaged_media()

    def test_outside_image_is_rejected(self):
        outside = self.root.parent / (self.root.name + '-outside.so')
        outside.write_bytes(b'test')
        try:
            image = self.root / 'av/_native.so'
            image.unlink(); image.symlink_to(outside)
            with self.assertRaises(ImportError): media.install_packaged_media()
        finally: outside.unlink()

    def test_loader_keeps_flags_metadata_and_balances_success_and_failure(self):
        library = types.SimpleNamespace(dlopen=Mock(return_value=42), dlclose=Mock(return_value=0))
        loader = media._NativeLoader(self.root / 'av/_native.so', 'haish_av_video_frame')
        spec = importlib.machinery.ModuleSpec('av.video.frame', loader)
        module = types.ModuleType('av.video.frame')
        with patch.object(media.ctypes, 'CDLL', return_value=library), patch.object(media._imp, 'create_dynamic', return_value=module) as create, patch.object(media._imp, 'exec_dynamic') as execute:
            self.assertIs(loader.create_module(spec), module)
            self.assertEqual(create.call_args.args[0].name, 'haish_av_video_frame')
            self.assertEqual(module.__name__, spec.name)
            self.assertEqual(module.__package__, 'av.video')
            self.assertIs(module.__spec__, spec)
            loader.exec_module(module)
            execute.assert_called_once_with(module)
        self.assertEqual(library.dlopen.call_args.args[1], sys.getdlopenflags())
        library.dlclose.assert_called_once_with(42)
        library.dlclose.reset_mock()
        with patch.object(media.ctypes, 'CDLL', return_value=library), patch.object(media._imp, 'create_dynamic', side_effect=ImportError('native failure')):
            with self.assertRaisesRegex(ImportError, 'native failure'): loader.create_module(spec)
        library.dlclose.assert_called_once_with(42)


if __name__ == '__main__': unittest.main()
