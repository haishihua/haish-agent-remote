import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SWIPE_BACK_CANCEL_EASING,
  SWIPE_BACK_COMPLETE_EASING,
  SWIPE_BACK_MAX_SETTLE_MS,
  isSwipeBackInFlight,
  setSwipeBackInFlight,
  swipeBackAxis,
  swipeBackOffset,
  swipeBackProgress,
  swipeBackRelease,
  swipeBackVelocity,
} from '../src/swipe-back.js';

const closeTo = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `${actual} is not within 1e-9 of ${expected}`,
);

test('swipe back follows the finger from inside the edge strip', () => {
  const start = { x: 18, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 78, y: 244 }), 60);
  assert.equal(swipeBackOffset(start, { x: 118, y: 248 }), 100);
});

test('swipe back keeps tracking the finger beyond the old 120px cap', () => {
  const start = { x: 12, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 272, y: 244 }), 260);
});

test('swipe back never moves left of the edge and never past a cap', () => {
  const start = { x: 12, y: 240 };
  assert.equal(swipeBackOffset(start, { x: 2, y: 240 }), 0);
  assert.equal(swipeBackOffset(start, { x: 500, y: 240 }, 390), 390);
});

test('swipe back waits for the pan threshold before claiming the touch', () => {
  assert.equal(swipeBackAxis(2, 1), null);
  assert.equal(swipeBackAxis(6, 5), null);
});

test('swipe back accepts a rightward pull inside the 40 degree cone', () => {
  assert.equal(swipeBackAxis(8, 6), 'horizontal');
  assert.equal(swipeBackAxis(40, 30), 'horizontal');
  assert.equal(swipeBackAxis(120, 4), 'horizontal');
});

test('swipe back leaves steep and leftward drags to the scroll view', () => {
  assert.equal(swipeBackAxis(8, 8), 'vertical');
  assert.equal(swipeBackAxis(20, 40), 'vertical');
  assert.equal(swipeBackAxis(-24, 2), 'vertical');
  assert.equal(swipeBackAxis(4, 4), null);
});

test('swipe back progress is the fraction of the screen the page travelled', () => {
  assert.equal(swipeBackProgress(0, 390), 0);
  assert.equal(swipeBackProgress(195, 390), 0.5);
  assert.equal(swipeBackProgress(500, 390), 1);
  assert.equal(swipeBackProgress(120, 0), 0);
});

test('swipe back velocity is smoothed and drops stale samples', () => {
  closeTo(swipeBackVelocity(0, { deltaX: 10, deltaMs: 10 }), 0.7);
  closeTo(swipeBackVelocity(1, { deltaX: 10, deltaMs: 10 }), 1);
  closeTo(swipeBackVelocity(0.5, { deltaX: 10, deltaMs: 300 }), 0.5);
  closeTo(swipeBackVelocity(0.5, { deltaX: 10, deltaMs: 0 }), 0.5);
});

test('swipe back completes a long pull and returns a short one', () => {
  const long = swipeBackRelease({ offset: 260, width: 390, velocity: 0.6 });
  assert.equal(long.complete, true);
  assert.equal(long.easing, SWIPE_BACK_COMPLETE_EASING);
  assert.equal(long.step, 260 / 390);

  const short = swipeBackRelease({ offset: 120, width: 390, velocity: 0.1 });
  assert.equal(short.complete, false);
  assert.equal(short.easing, SWIPE_BACK_CANCEL_EASING);
});

test('swipe back completes a flick that never crossed half the screen', () => {
  assert.equal(swipeBackRelease({ offset: 90, width: 390, velocity: 1.2 }).complete, true);
  assert.equal(swipeBackRelease({ offset: 90, width: 390, velocity: 0.1 }).complete, false);
  // Released while travelling back to the left: the pull returns even past halfway.
  assert.equal(swipeBackRelease({ offset: 240, width: 390, velocity: -0.4 }).complete, false);
  // 但只是抬手指时往回抖了一点点（速度负不到阈值）不算往回甩：过了半屏就该返回。
  assert.equal(swipeBackRelease({ offset: 240, width: 390, velocity: -0.05 }).complete, true);
  assert.equal(swipeBackRelease({ offset: 240, width: 390, velocity: -0.2 }).complete, false);
  // 过了半屏且不是往回甩：走完成那条收尾曲线。
  assert.equal(swipeBackRelease({ offset: 240, width: 390, velocity: -0.05 }).easing, SWIPE_BACK_COMPLETE_EASING);
});

test('swipe back settles over the remaining distance at the speed of the release', () => {
  assert.equal(swipeBackRelease({ offset: 300, width: 390, velocity: 1 }).durationMs, 90);
  assert.equal(swipeBackRelease({ offset: 300, width: 390, velocity: 0.2 }).durationMs, 180);
  assert.equal(swipeBackRelease({ offset: 100, width: 390, velocity: 5 }).durationMs, 90);
  assert.equal(
    swipeBackRelease({ offset: 200, width: 390, velocity: 0.01 }).durationMs,
    SWIPE_BACK_MAX_SETTLE_MS,
  );
  // Released without any speed the page still travels at the floor instead of jumping.
  assert.equal(swipeBackRelease({ offset: 120, width: 390, velocity: 0 }).durationMs, 240);
  // Nothing left to travel: settle on the spot.
  assert.equal(swipeBackRelease({ offset: 388, width: 390, velocity: 1 }).durationMs, 0);
});

test('swipe back reports an interactive transition in flight', () => {
  assert.equal(isSwipeBackInFlight(), false);
  setSwipeBackInFlight(true);
  assert.equal(isSwipeBackInFlight(), true);
  setSwipeBackInFlight(false);
  assert.equal(isSwipeBackInFlight(), false);
});
