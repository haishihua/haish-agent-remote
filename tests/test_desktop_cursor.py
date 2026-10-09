"""Cursor compositing regression: coordinates, clipping, stride and scaling."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from server.desktop_cursor import ARROW, composite_cursor
from server.macos_desktop import MacDesktop


class DesktopCursorTests(unittest.TestCase):
    def make_image(self, width=100, height=80, padding=8):
        stride = width*4+padding
        return bytearray(b'\x40\x50\x60\xff'*width + b'P'*padding)*height, stride

    def test_hotspot_uses_real_position_and_retina_bounds(self):
        data, stride = self.make_image()
        result = composite_cursor(data, 100, 80, stride, (35, 30), (10, 10, 50, 40))
        # 2x Retina mapping from global display points to image pixels.
        offset = 40*stride+50*4
        self.assertEqual(result[offset:offset+4], b'\x15\x15\x15\xff')
        self.assertEqual(result[(40+4)*stride+(50+2)*4:(40+4)*stride+(50+2)*4+4], b'\xff'*4)
        self.assertEqual(result[:offset], data[:offset])
        self.assertEqual(data[offset:offset+4], b'\x40\x50\x60\xff')

    def test_edges_clip_without_wrapping_or_corrupting_padding(self):
        data, stride = self.make_image()
        result = composite_cursor(data, 100, 80, stride, (99, 79), (0, 0, 100, 80))
        self.assertEqual(len(result), len(data))
        changed = [i for i, (a, b) in enumerate(zip(data, result)) if a != b]
        self.assertEqual(changed, list(range(79*stride+99*4, 79*stride+99*4+3)))
        for y in range(80):
            self.assertEqual(result[y*stride+400:(y+1)*stride], b'P'*8)

    def test_off_display_and_nonfinite_positions_are_not_clamped(self):
        data, stride = self.make_image()
        for pos in ((-1, 20), (100, 20), (20, -1), (20, 80), (float('nan'), 0), (0, float('inf'))):
            self.assertIs(composite_cursor(data, 100, 80, stride, pos, (0, 0, 100, 80)), data)
        for bounds in ((0, 0, 0, 80), (0, 0, 100, -1)):
            self.assertIs(composite_cursor(data, 100, 80, stride, (0, 0), bounds), data)

    def test_downscaled_video_keeps_pointer_legible(self):
        data, stride = self.make_image(width=200, height=200)
        normal = composite_cursor(data, 200, 200, stride, (0, 0), (0, 0, 200, 200), 1)
        small = composite_cursor(data, 200, 200, stride, (0, 0), (0, 0, 200, 200), .5)
        def rows_changed(result):
            return sum(result[y*stride:(y+1)*stride] != data[y*stride:(y+1)*stride] for y in range(200))
        self.assertEqual(rows_changed(small), 2*rows_changed(normal))
        self.assertTrue(all(len(row) == 16 for row in ARROW))

    def test_capture_composites_before_encoder_reformat(self):
        data, stride = self.make_image()
        plane_data = []
        frame = SimpleNamespace(planes=[SimpleNamespace(line_size=stride, buffer_size=len(data), update=plane_data.append)], reformat=lambda **kw: kw)
        q = SimpleNamespace(CGMainDisplayID=lambda: 1, CGDisplayCreateImage=lambda _: object(),
                            CGImageGetWidth=lambda _: 100, CGImageGetHeight=lambda _: 80,
                            CGImageGetBytesPerRow=lambda _: stride, CGImageGetDataProvider=lambda _: object(),
                            CGDataProviderCopyData=lambda _: data,
                            CGDisplayBounds=lambda _: SimpleNamespace(origin=SimpleNamespace(x=0, y=0), size=SimpleNamespace(width=100, height=80)))
        backend = object.__new__(MacDesktop); backend.q = q
        backend._position = lambda: SimpleNamespace(x=30, y=20)
        with patch('av.VideoFrame', return_value=frame):
            result = backend.capture(50, 40)
        self.assertEqual(plane_data[0], composite_cursor(data, 100, 80, stride, (30, 20), (0, 0, 100, 80), .5))
        self.assertEqual(result, {'width': 50, 'height': 40, 'format': 'yuv420p'})


if __name__ == '__main__':
    unittest.main()
