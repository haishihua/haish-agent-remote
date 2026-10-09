"""High-contrast pointer marker at the actual main-display mouse hotspot.

CoreGraphics display images exclude the system cursor. Composite a stable arrow
before encoding; do not predict position from remote input or expose coordinates
outside the authorized video stream. This marker does not mimic app-specific
cursor shapes (I-beam, resize, etc.).
"""
import math

# Hotspot is the top-left pixel. '#' is a dark outline, '+' a white fill.
ARROW = (
    '#...............',
    '##..............',
    '#+#.............',
    '#++#............',
    '#+++#...........',
    '#++++#..........',
    '#+++++#.........',
    '#++++++#........',
    '#+++++++#.......',
    '#++++++++#......',
    '#+++++++++#.....',
    '#++++++++++#....',
    '#+++++++++++#...',
    '#+++++++######..',
    '#++++#++#.......',
    '#+++#.#++#......',
    '#++#..#++#......',
    '#+#....#++#.....',
    '##.....#++#.....',
    '#.......#++#....',
    '........#++#....',
    '.........##.....',
)


def composite_cursor(data, width, height, stride, position, bounds, scale=1):
    """Return BGRA bytes with a clipped marker, preserving row padding.

    Position/bounds are in CoreGraphics points (top-left origin); capture pixels
    may be Retina-scaled. Keep the pointer legible after the video downscale.
    An off-display or invalid position must not fabricate an on-screen cursor.
    """
    x, y = position
    left, top, bw, bh = bounds
    if not all(math.isfinite(v) for v in (x, y, left, top, bw, bh, scale)):
        return data
    if bw <= 0 or bh <= 0 or scale <= 0 or not (left <= x < left+bw and top <= y < top+bh):
        return data
    px, py = int((x-left)*width/bw), int((y-top)*height/bh)
    unit_x = max(width/bw, 1.5/scale)
    unit_y = max(height/bh, 1.5/scale)
    cursor_width = math.ceil(len(ARROW[0])*unit_x)
    cursor_height = math.ceil(len(ARROW)*unit_y)
    result = bytearray(data)
    for dy in range(min(cursor_height, height-py)):
        row = ARROW[min(len(ARROW)-1, int(dy/unit_y))]
        for dx in range(min(cursor_width, width-px)):
            symbol = row[min(len(row)-1, int(dx/unit_x))]
            if symbol not in '#+':
                continue
            offset = (py+dy)*stride + (px+dx)*4
            result[offset:offset+4] = b'\x15\x15\x15\xff' if symbol == '#' else b'\xff\xff\xff\xff'
    return result
