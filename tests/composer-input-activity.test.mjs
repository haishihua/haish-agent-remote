import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPOSER_INPUT_QUIET_MS,
  createRecentInputActivity,
} from '../src/composer-input-activity.js';

test('input activity blocks background work only for the short typing window', () => {
  let now = 1_000;
  const activity = createRecentInputActivity({ now: () => now });

  assert.equal(activity.isActive(), false);
  activity.mark();
  assert.equal(activity.isActive(), true);
  assert.equal(activity.remaining(), COMPOSER_INPUT_QUIET_MS);

  now += COMPOSER_INPUT_QUIET_MS - 1;
  assert.equal(activity.isActive(), true);
  assert.equal(activity.remaining(), 1);
  now += 1;
  assert.equal(activity.isActive(), false);
  assert.equal(activity.remaining(), 0);
});

test('each keystroke extends the quiet window without making the keyboard permanently busy', () => {
  let now = 10;
  const activity = createRecentInputActivity({ quietMs: 100, now: () => now });

  activity.mark();
  now = 90;
  activity.mark();
  now = 150;
  assert.equal(activity.isActive(), true);
  now = 190;
  assert.equal(activity.isActive(), false);
});

test('invalid clocks do not leave input activity stuck on', () => {
  const activity = createRecentInputActivity({ quietMs: 100, now: () => Number.NaN });
  activity.mark();
  assert.equal(activity.isActive(), false);
});
