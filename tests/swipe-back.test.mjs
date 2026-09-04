import assert from 'node:assert/strict';
import test from 'node:test';

import { isSwipeBackGesture, swipeBackOffset } from '../src/swipe-back.js';

test('swipe back accepts a deliberate drag from the left edge', () => {
  const start = { x: 18, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 78, y: 244 }), 60);
  assert.equal(isSwipeBackGesture(start, { x: 118, y: 248 }), true);
});

test('swipe back ignores vertical movement and drags away from the edge', () => {
  assert.equal(swipeBackOffset({ x: 12, y: 100 }, { x: 34, y: 142 }), 0);
  assert.equal(isSwipeBackGesture({ x: 80, y: 100 }, { x: 190, y: 105 }), false);
});
