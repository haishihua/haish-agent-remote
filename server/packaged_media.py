"""Load the approved consolidated PyAV image only in macOS onefile builds.

The source installation still uses the upstream wheel. Every compiled module
keeps its upstream qualified name; only the exported entrypoint is unique.
ctypes preloading releases the GIL without bypassing OS signature validation.
"""
import ctypes
import importlib.abc
import importlib.machinery
import importlib.util
import _imp
import json
import os
from pathlib import Path
import re
import sys
import threading

_lock = threading.Lock()
_installed = False


class _NativeLoader(importlib.abc.Loader):
    def __init__(self, path, entrypoint):
        self.path = path
        self.entrypoint = entrypoint

    def create_module(self, spec):
        from server.media_diagnostics import record_native_load
        import time
        started = time.monotonic()
        library = ctypes.CDLL(None)
        dlopen, dlclose = library.dlopen, library.dlclose
        dlopen.argtypes = [ctypes.c_char_p, ctypes.c_int]
        dlopen.restype = ctypes.c_void_p
        dlclose.argtypes = [ctypes.c_void_p]
        dlclose.restype = ctypes.c_int
        handle = dlopen(os.fsencode(self.path), sys.getdlopenflags())
        try:
            # _imp locates PyInit_<entrypoint>; Cython retains the real full
            # module name for its type/capsule imports. Original errors propagate.
            alias = importlib.util.spec_from_file_location(self.entrypoint, self.path)
            module = _imp.create_dynamic(alias)
            module.__name__ = spec.name
            module.__spec__ = spec
            module.__loader__ = self
            module.__package__ = spec.parent
            module.__file__ = str(self.path)
            return module
        finally:
            # CPython holds its own dlopen reference. Balance ours on all paths.
            if handle:
                dlclose(handle)
            record_native_load(spec.name, time.monotonic() - started)

    def exec_module(self, module):
        _imp.exec_dynamic(module)


class _NativeFinder(importlib.abc.MetaPathFinder):
    def __init__(self, path, modules):
        self.path, self.modules = path, modules

    def find_spec(self, fullname, path=None, target=None):
        entrypoint = self.modules.get(fullname)
        if entrypoint is None:
            return None
        return importlib.machinery.ModuleSpec(
            fullname, _NativeLoader(self.path, entrypoint), origin=str(self.path))


def install_packaged_media():
    """Register only: do not load images or join warmup during app startup."""
    global _installed
    if not getattr(sys, 'frozen', False) or sys.platform != 'darwin':
        return
    with _lock:
        if _installed:
            return
        root = Path(sys._MEIPASS).resolve()
        manifest = root / 'av' / 'native-modules.json'
        if not manifest.exists():
            return  # Compatibility with earlier upstream-wheel frozen builds.
        if not manifest.resolve().is_relative_to(root):
            raise ImportError('Invalid packaged media manifest location')
        payload = json.loads(manifest.read_text(encoding='utf-8'))
        if not isinstance(payload, dict) or payload.get('version') != '16.1.0' or payload.get('schema') != 1:
            raise ImportError('Unsupported packaged media manifest')
        modules = payload.get('modules')
        if not isinstance(modules, dict) or not modules:
            raise ImportError('Invalid packaged media manifest')
        for name, entry in modules.items():
            if (not isinstance(name, str) or not re.fullmatch(r'av(?:\.[a-zA-Z_][a-zA-Z_0-9]*)+', name)
                    or entry != 'haish_' + name.replace('.', '_')):
                raise ImportError('Invalid packaged media entrypoint')
        image = (root / 'av' / '_native.so').resolve()
        if not image.is_relative_to(root) or not image.is_file():
            raise ImportError('Missing packaged media image')
        sys.meta_path.insert(0, _NativeFinder(image, dict(modules)))
        _installed = True
