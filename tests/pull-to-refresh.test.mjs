import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PULL_REFRESH_MAX_PX,
  PULL_REFRESH_RESISTANCE,
  PULL_REFRESH_TRIGGER_PX,
  isPullRefreshInFlight,
  pullRefreshArmed,
  pullRefreshAxis,
  pullRefreshDistance,
  pullRefreshProgress,
  setPullRefreshInFlight,
} from '../src/pull-to-refresh.js';

test('pull refresh follows the finger with resistance and never past the cap', () => {
  assert.equal(pullRefreshDistance(-20), 0);
  assert.equal(pullRefreshDistance(0), 0);
  assert.equal(pullRefreshDistance(100), 100 * PULL_REFRESH_RESISTANCE);
  assert.equal(pullRefreshDistance(10_000), PULL_REFRESH_MAX_PX);
});

test('pull refresh progress reaches 1 at the trigger distance and stays clamped', () => {
  assert.equal(pullRefreshProgress(0), 0);
  assert.equal(pullRefreshProgress(PULL_REFRESH_TRIGGER_PX / 2), 0.5);
  assert.equal(pullRefreshProgress(PULL_REFRESH_TRIGGER_PX), 1);
  assert.equal(pullRefreshProgress(PULL_REFRESH_MAX_PX), 1);
  assert.equal(pullRefreshProgress(-5), 0);
});

test('pull refresh waits for the start threshold before claiming the touch', () => {
  assert.equal(pullRefreshAxis(2, 3), null);
  assert.equal(pullRefreshAxis(0, 5), null);
});

test('pull refresh claims a downward drag inside the vertical cone', () => {
  assert.equal(pullRefreshAxis(0, 8), 'pull');
  assert.equal(pullRefreshAxis(4, 10), 'pull');
  assert.equal(pullRefreshAxis(-6, 30), 'pull');
});

test('pull refresh leaves upward, sideways and steep drags to the scroller', () => {
  // A left-edge swipe back starts at ~0° from horizontal: the pull must not take it.
  assert.equal(pullRefreshAxis(120, 4), 'scroll');
  assert.equal(pullRefreshAxis(40, 30), 'scroll');
  assert.equal(pullRefreshAxis(0, -40), 'scroll');
  assert.equal(pullRefreshAxis(0, -2), null);
});

test('pull refresh is armed only past the trigger distance', () => {
  assert.equal(pullRefreshArmed(0), false);
  assert.equal(pullRefreshArmed(PULL_REFRESH_TRIGGER_PX - 1), false);
  assert.equal(pullRefreshArmed(PULL_REFRESH_TRIGGER_PX), true);
  assert.equal(pullRefreshArmed(PULL_REFRESH_MAX_PX), true);
});

test('pull refresh reports a gesture in flight for the poll guards', () => {
  assert.equal(isPullRefreshInFlight(), false);
  setPullRefreshInFlight(true);
  assert.equal(isPullRefreshInFlight(), true);
  setPullRefreshInFlight(false);
  assert.equal(isPullRefreshInFlight(), false);
});
