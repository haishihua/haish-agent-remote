"""Buffer ownership regression without native capture/TCC side effects."""
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from server.macos_desktop import MacDesktop


class NativeBytes(bytearray):
    def __bytes__(self):
        raise AssertionError('Do not use native NSData __bytes__ conversion')


class CaptureBufferTests(unittest.TestCase):
    def test_capture_uses_buffer_and_keeps_stride_padding(self):
        for stride in (8, 12):
            source = NativeBytes(b'abcdefgh' + (b'PAD!' if stride == 12 else b'') + b'ijklmnop' + (b'PAD!' if stride == 12 else b''))
            received = []
            plane = SimpleNamespace(line_size=8, buffer_size=16, update=lambda data: received.append(data))
            frame = SimpleNamespace(planes=[plane], reformat=lambda **kwargs: kwargs)
            q = SimpleNamespace(CGDisplayCreateImage=lambda _: object(), CGMainDisplayID=lambda: 1, CGImageGetWidth=lambda _: 2, CGImageGetHeight=lambda _: 2, CGImageGetBytesPerRow=lambda _: stride, CGImageGetDataProvider=lambda _: object(), CGDataProviderCopyData=lambda _: source)
            backend = object.__new__(MacDesktop); backend.q = q
            with patch('av.VideoFrame', return_value=frame):
                result = backend.capture()
            self.assertEqual(received, [b'abcdefghijklmnop'])
            self.assertEqual(result, {'width': 2, 'height': 2, 'format': 'yuv420p'})


if __name__ == '__main__': unittest.main()
