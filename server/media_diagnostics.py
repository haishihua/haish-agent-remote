"""Thread-safe, privacy-safe cold-media timings for loopback diagnostics only."""
from contextlib import contextmanager
import threading
import time


class MediaDiagnostics:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.attempt = 0
        self.state = 'idle'
        self.started = None
        self.finished = None
        self.phase = None
        self.phase_started = None
        self.phases = {}
        self.native = {}

    def begin(self):
        with self.lock:
            self.attempt += 1
            self.state = 'loading'
            self.started = self.clock()
            self.finished = None
            self.phase = None
            self.phase_started = None
            self.phases = {}
            self.native = {}

    @contextmanager
    def stage(self, name):
        with self.lock:
            self.phase = name
            self.phase_started = self.clock()
        try:
            yield
        finally:
            with self.lock:
                self.phases[name] = self.clock() - self.phase_started
                self.phase = None
                self.phase_started = None

    def extension(self, name, seconds):
        # Coarse module groups only, never filenames, arbitrary spec names or
        # exception strings. No per-load logs and no unbounded series.
        group = name.split('.', 1)[0]
        if group not in {'av', 'cryptography', 'pylibsrtp', 'google_crc32c'}:
            group = 'other'
        with self.lock:
            item = self.native.setdefault(group, {'count': 0, 'seconds': 0.0, 'max_seconds': 0.0})
            item['count'] += 1
            item['seconds'] += seconds
            item['max_seconds'] = max(item['max_seconds'], seconds)

    def end(self, success):
        with self.lock:
            self.state = 'ready' if success else 'failed'
            self.finished = self.clock()

    def snapshot(self):
        with self.lock:
            now = self.clock()
            return {
                'attempt': self.attempt, 'state': self.state, 'phase': self.phase,
                'elapsed_seconds': round((self.finished if self.finished is not None else now) - self.started, 4) if self.started is not None else None,
                'phase_elapsed_seconds': round(now - self.phase_started, 4) if self.phase_started is not None else None,
                'phases_seconds': {k: round(v, 4) for k, v in self.phases.items()},
                'native_groups': {k: {key: round(value, 4) if isinstance(value, float) else value for key, value in v.items()} for k, v in self.native.items()},
            }


# The installed frozen loader reports only the current load_media thread's
# work. Never patch the extension loader again from diagnostic requests.
_observer = threading.local()


def record_native_load(name, seconds):
    diagnostics = getattr(_observer, 'diagnostics', None)
    if diagnostics is not None:
        diagnostics.extension(name, seconds)


@contextmanager
def media_stage(name):
    diagnostics = getattr(_observer, 'diagnostics', None)
    if diagnostics is None:
        yield
    else:
        with diagnostics.stage(name):
            yield


@contextmanager
def observe_native_loads(diagnostics):
    previous = getattr(_observer, 'diagnostics', None)
    _observer.diagnostics = diagnostics
    try:
        yield
    finally:
        _observer.diagnostics = previous
