import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_FIT_DEFER_LIMIT_MS,
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  composerTextareaHeight,
  createComposerTextareaFitScheduler,
  createComposerViewportResizeHandler,
  fitComposerTextarea,
} from '../src/composer-height.js';

// The native composer no longer calls these helpers: focused height is fixed in CSS so IME input
// performs no scrollHeight read. Keep the generic helpers covered for non-native/legacy callers.
test('generic textarea height helpers still clamp content', () => {
  assert.equal(composerTextareaHeight(0), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(69), 69);
  assert.equal(composerTextareaHeight(200), COMPOSER_TEXTAREA_MAX_HEIGHT);
  assert.equal(composerTextareaHeight(200, { minHeight: '48px', maxHeight: '90px' }), 90);
});

function fakeTextarea({ value = '', contentHeight = 48, height = '48px' } = {}) {
  const written = [];
  const textarea = { value, contentHeight, reads: 0, written, style: {} };
  Object.defineProperty(textarea, 'scrollHeight', {
    get: () => { textarea.reads += 1; return textarea.contentHeight; },
  });
  Object.defineProperty(textarea.style, 'height', {
    get: () => written[written.length - 1] ?? height,
    set: (next) => written.push(next),
  });
  return textarea;
}

const STYLES = { minHeight: '48px', maxHeight: '132px' };

test('generic fit can grow and shrink a textarea', () => {
  const textarea = fakeTextarea({ value: 'long', contentHeight: 90 });
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => STYLES }), 90);
  textarea.value = 'x';
  textarea.contentHeight = 48;
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => STYLES }), 48);
  assert.deepEqual(textarea.written, ['auto', '90px', 'auto', '48px']);
});

test('scheduled fits coalesce and remain cancellable', () => {
  const frames = [];
  const calls = [];
  const cancelled = [];
  const scheduler = createComposerTextareaFitScheduler({
    fit: (...args) => calls.push(args),
    requestFrame: (callback) => { frames.push(callback); return 41; },
    cancelFrame: (frame) => cancelled.push(frame),
  });
  scheduler.schedule({ value: 'a' });
  scheduler.schedule({ value: 'abc' }, { force: true });
  frames.shift()();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].value, 'abc');
  assert.deepEqual(calls[0][1], { force: true });
  scheduler.schedule({ value: 'drop' });
  scheduler.cancel();
  assert.deepEqual(cancelled, [41]);
});

test('generic fit defers while another motion owns the frame, with a hard limit', () => {
  const frames = [];
  const calls = [];
  let moving = true;
  let clock = 1000;
  const scheduler = createComposerTextareaFitScheduler({
    fit: (...args) => calls.push(args),
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => {},
    shouldDefer: () => moving,
    now: () => clock,
  });
  scheduler.schedule({ value: 'a' });
  frames.shift()();
  assert.equal(calls.length, 0);
  moving = false;
  frames.shift()();
  assert.equal(calls.length, 1);

  moving = true;
  clock = 5000;
  scheduler.schedule({ value: 'b' });
  const last = frames.shift();
  clock += COMPOSER_FIT_DEFER_LIMIT_MS;
  last();
  assert.equal(calls.length, 2);
});

test('generic viewport handler only reacts to width and can wait for composition', () => {
  let width = 390;
  let composing = true;
  const calls = [];
  const resize = createComposerViewportResizeHandler({
    readWidth: () => width,
    getTextarea: () => ({ value: '拼音' }),
    schedule: (...args) => calls.push(args),
    shouldSchedule: () => !composing,
  });
  assert.equal(resize(), false);
  width = 844;
  assert.equal(resize(), false);
  composing = false;
  assert.equal(resize(), true);
  assert.equal(calls.length, 1);
});
