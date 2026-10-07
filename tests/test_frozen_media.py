import ctypes
from importlib.machinery import ExtensionFileLoader
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from server import frozen_media


class FrozenMediaTests(unittest.TestCase):
    def test_source_and_non_mac_are_unchanged(self):
        for frozen, platform in ((False, 'darwin'), (True, 'linux')):
            with patch.object(frozen_media.sys, 'frozen', frozen, create=True), patch.object(frozen_media.sys, 'platform', platform), patch.object(frozen_media.ctypes, 'CDLL') as cdll:
                frozen_media.install_gil_safe_loader()
                cdll.assert_not_called()

    def test_bundled_loader_balances_references_and_preserves_flags(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            library = Mock()
            library.dlopen.return_value = 123
            original = Mock(return_value='module')
            with patch.object(frozen_media.sys, 'frozen', True, create=True), patch.object(frozen_media.sys, 'platform', 'darwin'), patch.object(frozen_media.sys, '_MEIPASS', directory, create=True), patch.object(frozen_media, '_installed', False), patch.object(frozen_media.ctypes, 'CDLL', return_value=library) as cdll, patch.object(ExtensionFileLoader, 'create_module', original):
                frozen_media.install_gil_safe_loader()
                wrapper = ExtensionFileLoader.create_module
                frozen_media.install_gil_safe_loader()
                self.assertIs(wrapper, ExtensionFileLoader.create_module)
                cdll.assert_called_once_with(None)
                loader = Mock()
                spec = SimpleNamespace(origin=str(root/'av'/'frame.so'))
                self.assertEqual(wrapper(loader, spec), 'module')
                library.dlopen.assert_called_once_with(str(root/'av'/'frame.so').encode(), frozen_media.sys.getdlopenflags())
                library.dlclose.assert_called_once_with(123)
                self.assertEqual(library.dlopen.restype, ctypes.c_void_p)
                original.side_effect = ImportError('failed init')
                with self.assertRaises(ImportError):
                    wrapper(loader, spec)
                self.assertEqual(library.dlclose.call_count, 2)
                original.side_effect = None
                library.reset_mock()
                wrapper(loader, SimpleNamespace(origin=str(root.parent/'outside.so')))
                wrapper(loader, SimpleNamespace(origin=None))
                library.dlopen.assert_not_called()
                library.dlopen.return_value = None
                wrapper(loader, spec)  # let CPython give its normal load error
                library.dlclose.assert_not_called()
