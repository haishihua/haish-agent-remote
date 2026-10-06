"""macOS-only capture/input bridge, shipped inside the frozen adapter.

No permission prompts from network requests. Only the local management page may
request TCC consent. CoreGraphics captures the main display on the 14.x target.
"""
import platform

KEYS = {'Cmd': 55, 'Ctrl': 59, 'Option': 58, 'Shift': 56, 'Esc': 53,
        'Tab': 48, 'Enter': 36, 'Backspace': 51, 'ArrowLeft': 123,
        'ArrowRight': 124, 'ArrowDown': 125, 'ArrowUp': 126}
FLAGS = {'Cmd': 1 << 20, 'Ctrl': 1 << 18, 'Option': 1 << 19, 'Shift': 1 << 17}


class MacDesktop:
    def __init__(self):
        self.q = None
        self.ax = None
        self.keys = set()
        self.buttons = set()
        if platform.system() == 'Darwin' and platform.machine() == 'arm64':
            try:
                import Quartz
                import ApplicationServices
                self.q = Quartz
                self.ax = ApplicationServices
            except ImportError:
                pass

    def status(self):
        q = self.q
        supported = bool(q and tuple(map(int, platform.mac_ver()[0].split('.'))) >= (14, 8, 9))
        session = q.CGSessionCopyCurrentDictionary() if q else None
        return {'supported': supported,
                'screen_recording': bool(q and q.CGPreflightScreenCaptureAccess()),
                'accessibility': bool(self.ax and self.ax.AXIsProcessTrusted()),
                # Fail closed if there is no logged-in console session.
                'unlocked': bool(session and session.get('kCGSSessionOnConsoleKey') and
                                 session.get('kCGSessionLoginDoneKey') and
                                 not session.get('CGSSessionScreenIsLocked', False))}

    def request_permissions(self):
        if self.q:
            self.q.CGRequestScreenCaptureAccess()
            self.ax.AXIsProcessTrustedWithOptions({self.ax.kAXTrustedCheckOptionPrompt: True})

    def capture(self, width=1920, height=1080):
        from av import VideoFrame
        q = self.q
        image = q.CGDisplayCreateImage(q.CGMainDisplayID())
        if image is None:
            raise RuntimeError('capture_unavailable')
        w, h = q.CGImageGetWidth(image), q.CGImageGetHeight(image)
        stride = q.CGImageGetBytesPerRow(image)
        data = bytes(q.CGDataProviderCopyData(q.CGImageGetDataProvider(image)))
        frame = VideoFrame(w, h, 'bgra')
        plane = frame.planes[0]
        if stride == plane.line_size:
            plane.update(data[:plane.buffer_size])
        else:
            plane.update(b''.join(data[y*stride:y*stride+w*4].ljust(plane.line_size, b'\0') for y in range(h)))
        scale = min(width/w, height/h, 1)
        return frame.reformat(width=max(2, int(w*scale)//2*2), height=max(2, int(h*scale)//2*2), format='yuv420p')

    def _position(self):
        q = self.q
        return q.CGEventGetLocation(q.CGEventCreate(None))

    def _flags(self):
        return sum(FLAGS.get(key, 0) for key in self.keys)

    def _key(self, key, down):
        q = self.q
        event = q.CGEventCreateKeyboardEvent(None, KEYS[key], down)
        q.CGEventSetFlags(event, self._flags())
        q.CGEventPost(q.kCGHIDEventTap, event)

    def _button(self, button, down, count=1):
        q = self.q
        right = button == 'right'
        kind = (q.kCGEventRightMouseDown if down else q.kCGEventRightMouseUp) if right else (q.kCGEventLeftMouseDown if down else q.kCGEventLeftMouseUp)
        event = q.CGEventCreateMouseEvent(None, kind, self._position(), q.kCGMouseButtonRight if right else q.kCGMouseButtonLeft)
        q.CGEventSetIntegerValueField(event, q.kCGMouseEventClickState, count)
        q.CGEventSetFlags(event, self._flags())
        q.CGEventPost(q.kCGHIDEventTap, event)

    def input(self, message):
        q = self.q
        kind = message['type']
        if kind == 'move':
            bounds = q.CGDisplayBounds(q.CGMainDisplayID())
            pos = self._position()
            x = max(bounds.origin.x, min(bounds.origin.x + bounds.size.width - 1, pos.x + message['dx'] * bounds.size.width))
            y = max(bounds.origin.y, min(bounds.origin.y + bounds.size.height - 1, pos.y + message['dy'] * bounds.size.height))
            event_kind = q.kCGEventLeftMouseDragged if 'left' in self.buttons else q.kCGEventMouseMoved
            event = q.CGEventCreateMouseEvent(None, event_kind, (x, y), q.kCGMouseButtonLeft)
            q.CGEventSetFlags(event, self._flags())
            q.CGEventPost(q.kCGHIDEventTap, event)
        elif kind == 'button':
            button, down = message['button'], message['down']
            (self.buttons.add if down else self.buttons.discard)(button)
            self._button(button, down)
        elif kind == 'click':
            for count in range(1, message.get('count', 1) + 1):
                self._button(message['button'], True, count)
                self._button(message['button'], False, count)
        elif kind == 'scroll':
            event = q.CGEventCreateScrollWheelEvent(None, q.kCGScrollEventUnitPixel, 2, round(message['dy']), round(message['dx']))
            q.CGEventPost(q.kCGHIDEventTap, event)
        elif kind == 'key':
            key, down = message['key'], message['down']
            (self.keys.add if down else self.keys.discard)(key)
            self._key(key, down)
        elif kind == 'text':
            # UTF-16 preserves Chinese and supplementary Unicode characters.
            text = message['text']
            for chunk in [text[i:i+32] for i in range(0, len(text), 32)]:
                for down in (True, False):
                    event = q.CGEventCreateKeyboardEvent(None, 0, down)
                    q.CGEventKeyboardSetUnicodeString(event, len(chunk.encode('utf-16-le'))//2, chunk)
                    q.CGEventPost(q.kCGHIDEventTap, event)
        elif kind == 'release':
            self.release()

    def release(self):
        if not self.q:
            return
        for key in list(self.keys):
            self.keys.discard(key)
            self._key(key, False)
        for button in list(self.buttons):
            self.buttons.discard(button)
            self._button(button, False)
