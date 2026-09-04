import assert from 'node:assert/strict';
import test from 'node:test';

import { isSwipeBackGesture, swipeBackOffset } from '../src/swipe-back.js';

test('swipe back accepts a deliberate drag from the left edge', () => {
  const start = { x: 18, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 78, y: 244 }), 60);
  assert.equal(isSwipeBackGesture(start, { x: 118, y: 248 }), true);
});

test('swipe back keeps tracking the finger beyond the old 120px cap', () => {
  const start = { x: 12, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 272, y: 244 }), 260);
});

test('swipe back accepts a quick flick but rejects the same short slow drag', () => {
  const start = { x: 12, y: 240 };
  const end = { x: 72, y: 243 };
  assert.equal(isSwipeBackGesture(start, end, { width: 390, elapsedMs: 80 }), true);
  assert.equal(isSwipeBackGesture(start, end, { width: 390, elapsedMs: 400 }), false);
});

test('swipe back ignores drags away from the edge and rejects vertical completion', () => {
  assert.equal(swipeBackOffset({ x: 12, y: 100 }, { x: 4, y: 100 }), 0);
  assert.equal(isSwipeBackGesture({ x: 12, y: 100 }, { x: 34, y: 142 }), false);
  assert.equal(isSwipeBackGesture({ x: 80, y: 100 }, { x: 190, y: 105 }), false);
});
