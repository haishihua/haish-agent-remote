"""Keep macOS onefile native loading from holding Python's GIL.

CPython's extension loader calls dlopen while holding the GIL. On macOS a newly
extracted Mach-O may spend seconds in system code-signature validation. A worker
thread alone therefore cannot keep signaling/lease watchdogs responsive. Load
bundled extensions with the *same* dlopen flags through ctypes first (which
releases the GIL), then let CPython initialize them normally. No security check
is bypassed, no dependency is changed, and no capture/input is performed here.
"""
import ctypes
from importlib.machinery import ExtensionFileLoader
import os
from pathlib import Path
import sys
import threading

_install_lock = threading.Lock()
_installed = False


def install_gil_safe_loader():
    global _installed
    if not getattr(sys, 'frozen', False) or sys.platform != 'darwin':
        return
    with _install_lock:
        if _installed:
            return
        root = Path(sys._MEIPASS).resolve()
        library = ctypes.CDLL(None)
        dlopen = library.dlopen
        dlopen.argtypes = [ctypes.c_char_p, ctypes.c_int]
        dlopen.restype = ctypes.c_void_p
        dlclose = library.dlclose
        dlclose.argtypes = [ctypes.c_void_p]
        dlclose.restype = ctypes.c_int
        original = ExtensionFileLoader.create_module

        def create_module(loader, spec):
            # Only adapter-owned extracted code. Ordinary import discovery and
            # CPython's error handling remain authoritative.
            path = Path(spec.origin).resolve() if spec.origin else None
            if path is None or not path.is_relative_to(root):
                return original(loader, spec)
            handle = dlopen(os.fsencode(path), sys.getdlopenflags())
            try:
                return original(loader, spec)
            finally:
                # CPython owns a separate dlopen reference after successful
                # creation. Balance ours on success AND initialization failure.
                if handle:
                    dlclose(handle)

        ExtensionFileLoader.create_module = create_module
        _installed = True
