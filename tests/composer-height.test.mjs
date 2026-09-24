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

test('an empty or single-line draft stays on the one-line height', () => {
  assert.equal(composerTextareaHeight(0), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(21), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(47), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(undefined), COMPOSER_TEXTAREA_MIN_HEIGHT);
});

test('the height follows the content instead of a reserved box', () => {
  assert.equal(composerTextareaHeight(48), 48);
  assert.equal(composerTextareaHeight(69), 69);
  assert.equal(composerTextareaHeight(111), 111);
});

test('the CSS cap wins once the draft is longer than the box may grow', () => {
  assert.equal(composerTextareaHeight(132), COMPOSER_TEXTAREA_MAX_HEIGHT);
  assert.equal(composerTextareaHeight(200), COMPOSER_TEXTAREA_MAX_HEIGHT);
  assert.equal(composerTextareaHeight(200, { minHeight: '48px', maxHeight: '90px' }), 90);
});

test('the bounds come from the stylesheet, and a missing one never collapses the box', () => {
  assert.equal(composerTextareaHeight(10, { minHeight: '52px' }), 52);
  assert.equal(composerTextareaHeight(10, { minHeight: 'none', maxHeight: 'none' }), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(10, { minHeight: 'auto' }), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(400, { maxHeight: '40px', minHeight: '60px' }), 60);
});

const COMPOSER_STYLES = { minHeight: '48px', maxHeight: '132px' };

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

test('fitting measures the content again so a deleted draft shortens the box', () => {
  const textarea = fakeTextarea({ value: 'a longer draft', contentHeight: 90 });
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES }), 90);
  assert.deepEqual(textarea.written, ['auto', '90px']);

  // 删到一行：还是要走 `auto`，否则框只会长高不会变矮。
  textarea.value = 'a';
  textarea.contentHeight = 48;
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES }), 48);
  assert.deepEqual(textarea.written.slice(2), ['auto', '48px']);

  assert.equal(fitComposerTextarea(null), 0);
});

test('typing more of the same line reads the content once and writes nothing', () => {
  const textarea = fakeTextarea({ value: 'hello' });
  let styleReads = 0;
  const getStyles = () => { styleReads += 1; return COMPOSER_STYLES; };
  assert.equal(fitComposerTextarea(textarea, { getStyles }), 48);
  assert.equal(styleReads, 1);
  const writes = textarea.written.length;

  // 又敲了一个字，还是一行：不走 `auto`，没有变高就不写任何字节（写 CSS 会让布局失效）。
  textarea.value = 'hello!';
  assert.equal(fitComposerTextarea(textarea, { getStyles }), 48);
  assert.equal(textarea.written.length, writes);
  assert.equal(styleReads, 1, '上下限每个元素只读一次');
});

test('a draft that wraps grows the box from the reading alone', () => {
  const textarea = fakeTextarea({ value: 'hello' });
  fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES });
  textarea.written.length = 0;

  textarea.value = 'hello, this one wrapped';
  textarea.contentHeight = 69;
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES }), 69);
  assert.deepEqual(textarea.written, ['69px'], '长高那一趟不写 auto');
});

test('the same draft is not measured again', () => {
  const textarea = fakeTextarea({ value: 'same' });
  fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES });
  const writes = textarea.written.length;
  textarea.reads = 0;

  // effect 因为别的原因又跑了一遍（比如 runConfig 解析完）：草稿没变，连 scrollHeight 都不读。
  textarea.contentHeight = 999;
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES }), 48);
  assert.equal(textarea.reads, 0);
  assert.equal(textarea.written.length, writes);
});

test('a forced fit re-measures even when the draft did not change', () => {
  const textarea = fakeTextarea({ value: 'hello', contentHeight: 69 });
  fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES });
  textarea.written.length = 0;
  textarea.reads = 0;

  // 展开/旋转屏幕：同一份草稿的折行变了，必须重量——走 `auto` 那一趟（先 auto 再写回）。
  assert.equal(fitComposerTextarea(textarea, { getStyles: () => COMPOSER_STYLES, force: true }), 69);
  assert.deepEqual(textarea.written, ['auto', '69px']);
  assert.equal(textarea.reads, 1);
});

test('rapid textarea fits coalesce into one animation-frame measurement', () => {
  const frames = [];
  const calls = [];
  const scheduler = createComposerTextareaFitScheduler({
    fit: (textarea, options) => calls.push({ textarea, options }),
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => {},
  });
  const first = { value: 'a' };
  const latest = { value: 'abc' };

  scheduler.schedule(first);
  scheduler.schedule(latest);
  scheduler.schedule(latest, { force: true });

  assert.equal(frames.length, 1);
  assert.deepEqual(calls, []);
  frames[0]();
  assert.deepEqual(calls, [{ textarea: latest, options: { force: true } }]);
});

test('keyboard height-only resizes do not force a textarea layout measurement', () => {
  let width = 390;
  const textarea = { value: 'marked text' };
  const calls = [];
  const resize = createComposerViewportResizeHandler({
    readWidth: () => width,
    getTextarea: () => textarea,
    schedule: (...args) => calls.push(args),
  });

  assert.equal(resize(), false);
  assert.deepEqual(calls, []);

  width = 844;
  assert.equal(resize(), true);
  assert.deepEqual(calls, [[textarea, { force: true }]]);
});

test('a width fit waits until IME composition has committed', () => {
  let width = 390;
  let composing = true;
  const calls = [];
  const resize = createComposerViewportResizeHandler({
    readWidth: () => width,
    getTextarea: () => ({ value: '拼音' }),
    schedule: (...args) => calls.push(args),
    shouldSchedule: () => !composing,
  });

  width = 844;
  assert.equal(resize(), false);
  assert.deepEqual(calls, []);
  composing = false;
  assert.equal(resize(), true);
  assert.equal(calls.length, 1);
});

test('cancelling a scheduled textarea fit drops its pending layout read', () => {
  const frames = [];
  const cancelled = [];
  const calls = [];
  const scheduler = createComposerTextareaFitScheduler({
    fit: (...args) => calls.push(args),
    requestFrame: (callback) => { frames.push(callback); return 41; },
    cancelFrame: (frame) => cancelled.push(frame),
  });

  scheduler.schedule({ value: 'draft' });
  scheduler.cancel();

  assert.deepEqual(cancelled, [41]);
  assert.deepEqual(calls, []);
});

test('a textarea fit waits out a keyboard motion instead of landing inside it', () => {
  const frames = [];
  const calls = [];
  let moving = true;
  let clock = 1_000;
  const scheduler = createComposerTextareaFitScheduler({
    fit: (...args) => calls.push(args),
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => {},
    shouldDefer: () => moving,
    now: () => clock,
  });
  const textarea = { value: 'hello' };

  // 键盘那趟动画正好在这个窗口里：`height: auto` + `scrollHeight` 的强制布局先不量，排到下一帧。
  scheduler.schedule(textarea, { force: true });
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 1, '排到下一帧再来');

  // 键盘落地：下一帧就量，`force` 也没丢。
  moving = false;
  frames.shift()();
  assert.deepEqual(calls, [[textarea, { force: true }]]);

  // 状态万一没回来（一直说「还在动」）：到了上限也不再等，否则输入框就永远不跟着长高了。
  moving = true;
  clock = 5_000;
  scheduler.schedule({ value: 'x' });
  const pending = frames.shift();
  clock = 5_000 + COMPOSER_FIT_DEFER_LIMIT_MS;
  pending();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [{ value: 'x' }, { force: false }]);
});
