import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopGestures } from '../src/desktop-gestures.js';

test('default browser timers retain the Window receiver', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let scheduled = 0, cancelled = 0;
  globalThis.setTimeout = function () { assert.equal(this, globalThis); scheduled++; return 1; };
  globalThis.clearTimeout = function () { assert.equal(this, globalThis); cancelled++; };
  try {
    const gestures = new DesktopGestures({ send: () => true });
    gestures.down(1, 0, 0);
    gestures.reset(true);
    assert.equal(scheduled, 1);
    assert.ok(cancelled >= 2);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

function setup({ accepted = true } = {}) {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const commands = [], zoom = [], drag = [];
  const gestures = new DesktopGestures({
    send: (command) => { commands.push(command); return accepted; },
    onZoom: (ratio) => zoom.push(ratio),
    onDrag: (active) => drag.push(active),
    now: () => time,
    schedule: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const target = time + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      time = timer.at;
      timers.delete(id);
      timer.callback();
    }
    time = target;
  };
  return { gestures, commands, zoom, drag, advance, timers };
}

const click = (count = 1) => ({ type: 'click', button: 'left', count });
const button = (down) => ({ type: 'button', button: 'left', down });
const move = (g, id, x, y) => g.move(id, x, y, 200, 100);
const tap = (g, id = 1) => { g.down(id, 0, 0); g.up(id); };
const pair = (g) => { g.down(1, 0, 0); g.down(2, 100, 0); };

for (const [name, dx, dy] of [
  ['horizontal right', 30, 0], ['horizontal left', -30, 0],
  ['vertical', 0, 30], ['diagonal down', 30, 30], ['diagonal up', -30, -30],
]) {
  for (const order of [[1, 2], [2, 1]]) {
    test(`parallel ${name} sequential updates (${order}) scroll, not pinch`, () => {
      const { gestures: g, commands, zoom, advance } = setup();
      pair(g);
      move(g, order[0], (order[0] === 2 ? 100 : 0) + dx, dy);
      assert.equal(g.mode, null);
      assert.deepEqual(commands, []);
      assert.deepEqual(zoom, []);
      move(g, order[1], (order[1] === 2 ? 100 : 0) + dx, dy);
      assert.equal(g.mode, 'scroll');
      assert.deepEqual(commands, [{ type: 'scroll', dx: -dx || 0, dy: -dy || 0 }]);
      move(g, 1, dx * 2, dy * 2);
      move(g, 2, 100 + dx * 2, dy * 2);
      assert.equal(g.mode, 'scroll', 'classification stays locked');
      assert.deepEqual(zoom, []);
      g.up(1);
      const count = commands.length;
      move(g, 2, 200, 50);
      advance(500);
      g.up(2);
      advance(1000);
      assert.equal(commands.length, count, 'remaining finger does not move, drag, or tap');
    });
  }
}

for (const [name, first, second, expected] of [
  ['outward', [-20, 0], [120, 0], 1.4],
  ['inward', [20, 0], [80, 0], 0.6],
  ['diagonal outward', [-20, -20], [120, 20], Math.hypot(140, 40) / 100],
]) {
  for (const order of [[1, 2], [2, 1]]) {
    test(`diverging ${name} motion (${order}) pinches from the shared start`, () => {
      const { gestures: g, commands, zoom, advance } = setup();
      pair(g);
      const positions = { 1: first, 2: second };
      move(g, order[0], ...positions[order[0]]);
      assert.equal(g.mode, null);
      move(g, order[1], ...positions[order[1]]);
      assert.equal(g.mode, 'pinch');
      assert.ok(Math.abs(zoom[0] - expected) < 1e-12);
      assert.deepEqual(commands, []);
      const before = Math.hypot(first[0] - second[0], first[1] - second[1]);
      move(g, 2, second[0] + 10, second[1]);
      assert.equal(g.mode, 'pinch');
      assert.ok(Math.abs(zoom[1] - Math.hypot(first[0] - second[0] - 10, first[1] - second[1]) / before) < 1e-12);
      g.up(2); g.up(1); advance(1000);
      assert.deepEqual(commands, []);
    });
  }
}

test('both fingers must exceed the movement slop, measured from multiStart', () => {
  const { gestures: g, commands, zoom } = setup();
  g.down(1, 0, 0);
  move(g, 1, 50, 0);
  g.down(2, 150, 0);
  commands.length = 0;
  move(g, 1, 100, 0);
  move(g, 2, 153, 4); // Exactly five pixels is not meaningful motion.
  assert.equal(g.mode, null);
  assert.deepEqual(commands, []);
  assert.deepEqual(zoom, []);
  move(g, 2, 156, 0);
  assert.equal(g.mode, 'scroll', 'unequal but aligned movement is still scroll');
  assert.deepEqual(commands, [{ type: 'scroll', dx: -28, dy: 0 }]);
});

test('tiny two-finger jitter neither classifies nor taps or holds', () => {
  const { gestures: g, commands, zoom, advance } = setup();
  pair(g);
  move(g, 1, 2, 1); move(g, 2, 102, 1);
  advance(1000);
  assert.equal(g.mode, null);
  g.up(1); g.up(2); advance(1000);
  assert.deepEqual(commands, []);
  assert.deepEqual(zoom, []);
});

test('scroll output is bounded and accumulated classification motion is not lost', () => {
  const { gestures: g, commands } = setup();
  pair(g);
  move(g, 1, 4000, -4000); move(g, 2, 4100, -4000);
  assert.deepEqual(commands, [{ type: 'scroll', dx: -1000, dy: 1000 }]);
});

test('third finger suspends recognition and rebases the remaining pair', () => {
  const { gestures: g, commands, zoom, advance } = setup();
  pair(g);
  move(g, 1, 20, 0); move(g, 2, 120, 0);
  g.down(3, 200, 0);
  const count = commands.length;
  move(g, 1, 40, 0); move(g, 2, 140, 0); move(g, 3, 220, 0);
  assert.equal(commands.length, count);
  g.up(1);
  move(g, 2, 160, 0);
  assert.equal(g.mode, null);
  move(g, 3, 240, 0);
  assert.equal(g.mode, 'scroll');
  assert.deepEqual(commands.at(-1), { type: 'scroll', dx: -20, dy: 0 });
  g.up(2); g.up(3); advance(1000);
  assert.deepEqual(zoom, []);
  assert.ok(commands.every((command) => command.type === 'scroll'));
});

test('single tap is delayed exactly 300ms', () => {
  const { gestures: g, commands, advance, timers } = setup();
  tap(g);
  assert.deepEqual(commands, []);
  advance(299);
  assert.deepEqual(commands, []);
  advance(1);
  assert.deepEqual(commands, [click()]);
  advance(1000);
  assert.deepEqual(commands, [click()]);
  assert.equal(timers.size, 0);
});

test('double tap cancels the delayed single click without a later extra click', () => {
  const { gestures: g, commands, advance } = setup();
  tap(g);
  advance(299);
  tap(g, 2);
  assert.deepEqual(commands, [click(2)]);
  advance(1000);
  assert.deepEqual(commands, [click(2)]);
});

test('taps 300ms apart are two singles, not a double', () => {
  const { gestures: g, commands, advance } = setup();
  tap(g); advance(300); tap(g, 2); advance(300);
  assert.deepEqual(commands, [click(), click()]);
});

test('multi contact cancels a pending tap and clears double-tap history', () => {
  const { gestures: g, commands, advance } = setup();
  tap(g); advance(100);
  pair(g);
  g.up(1); g.up(2); advance(1000);
  assert.deepEqual(commands, []);
  tap(g); advance(300);
  assert.deepEqual(commands, [click()]);
});

test('normal pointer movement is normalized and clamped, cancels tap and hold', () => {
  const { gestures: g, commands, advance } = setup();
  g.down(1, 0, 0);
  move(g, 1, 20, -10);
  g.move(1, 10000, -10000, 0, 0);
  assert.deepEqual(commands, [
    { type: 'move', dx: 0.1, dy: -0.1 },
    { type: 'move', dx: 1, dy: -1 },
  ]);
  advance(1000); g.up(1); advance(1000);
  assert.equal(commands.length, 2);
});

test('long hold starts drag at 450ms and lifting releases once with no tap', () => {
  const { gestures: g, commands, drag, advance } = setup();
  g.down(1, 0, 0);
  advance(449);
  assert.deepEqual(commands, []);
  advance(1);
  assert.deepEqual(commands, [button(true)]);
  assert.deepEqual(drag, [true]);
  move(g, 1, 20, 10);
  g.up(1); g.up(1); advance(1000);
  assert.deepEqual(commands, [button(true), { type: 'move', dx: 0.1, dy: 0.1 }, button(false)]);
  assert.deepEqual(drag, [true, false]);
});

test('release after tap deadline but before hold deadline produces neither click nor drag', () => {
  const { gestures: g, commands, advance } = setup();
  g.down(1, 0, 0); advance(400); g.up(1); advance(1000);
  assert.deepEqual(commands, []);
});

test('rejected hold does not claim drag or send a button-up or tap', () => {
  const { gestures: g, commands, drag, advance } = setup({ accepted: false });
  g.down(1, 0, 0); advance(450); g.up(1); advance(1000);
  assert.deepEqual(commands, [button(true)]);
  assert.deepEqual(drag, [false]);
  assert.equal(g.dragging, false);
});

test('adding a second finger releases an active drag and does not rehold or tap', () => {
  const { gestures: g, commands, drag, advance } = setup();
  g.down(1, 0, 0); advance(450); g.down(2, 100, 0);
  assert.deepEqual(commands, [button(true), button(false)]);
  g.up(2); advance(1000); g.up(1); advance(1000);
  assert.deepEqual(commands, [button(true), button(false)]);
  assert.deepEqual(drag, [true, false]);
});

for (const state of ['pending hold', 'pending click', 'active drag', 'multi']) {
  test(`pointer cancellation during ${state} releases all and cancels timers`, () => {
    const { gestures: g, commands, drag, advance, timers } = setup();
    if (state === 'pending click') tap(g, 9);
    g.down(1, 0, 0);
    if (state === 'active drag') advance(450);
    if (state === 'multi') g.down(2, 100, 0);
    g.up(1, true);
    const expected = state === 'active drag' ? [button(true), { type: 'release' }] : [{ type: 'release' }];
    assert.deepEqual(commands, expected);
    assert.equal(g.points.size, 0);
    assert.equal(g.gesture, null);
    assert.equal(g.mode, null);
    assert.equal(g.multiStart, null);
    assert.equal(g.dragging, false);
    assert.equal(g.lastTap, null);
    assert.equal(drag.at(-1), false);
    assert.equal(timers.size, 0);
    g.up(1, true); g.up(2, true); move(g, 2, 30, 30); advance(1000);
    assert.deepEqual(commands, expected);
    tap(g, 3); advance(300);
    assert.deepEqual(commands, [...expected, click()]);
  });
}

for (const release of [false, true]) {
  for (const state of ['pending hold', 'pending click', 'active drag', 'multi']) {
    test(`reset(${release}) during ${state} clears local state and timers`, () => {
      const { gestures: g, commands, advance, timers } = setup();
      if (state === 'pending click') tap(g);
      else g.down(1, 0, 0);
      if (state === 'active drag') advance(450);
      if (state === 'multi') { g.down(2, 100, 0); move(g, 1, 20, 0); move(g, 2, 120, 0); }
      const before = [...commands];
      g.reset(release);
      const expected = release ? [...before, { type: 'release' }] : before;
      assert.deepEqual(commands, expected);
      assert.equal(g.points.size, 0);
      assert.equal(g.gesture, null);
      assert.equal(g.mode, null);
      assert.equal(g.multiStart, null);
      assert.equal(g.dragging, false);
      assert.equal(g.lastTap, null);
      assert.equal(timers.size, 0);
      g.up(1); g.up(2); advance(1000);
      assert.deepEqual(commands, expected);
      tap(g, 3); advance(300);
      assert.deepEqual(commands, [...expected, click()]);
    });
  }
}

test('unknown pointers do not move, release, cancel, or interfere with a valid tap', () => {
  const { gestures: g, commands, advance } = setup();
  move(g, 99, 10, 10); g.up(99, true);
  g.down(1, 0, 0);
  move(g, 99, 10, 10); g.up(99, true);
  g.up(1); advance(300);
  assert.deepEqual(commands, [click()]);
});
