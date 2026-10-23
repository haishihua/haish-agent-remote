import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { afterPaint, createDismissHandoff, DIRECTORY_HOLD_CLASS } from '../src/dismiss-handoff.js';

function fakeRaf() {
  const queue = [];
  return {
    queue,
    raf: (callback) => {
      queue.push(callback);
      return queue.length;
    },
    // 只跑这一轮排进来的回调：回调里再排的属于下一帧。
    flush: () => queue.splice(0).forEach((callback) => callback()),
  };
}

test('the hold class matches the one styles.css pauses the directory with', async () => {
  assert.equal(DIRECTORY_HOLD_CLASS, 'detail-closing');
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  // 目录（含 `detail-closing` 那两帧）靠这条暂停规则停在最后一帧；提示栈被排除在外，
  // 详情页开着时的 toast 才有动画（见 tests/toast-notices.test.mjs）。
  assert.match(css, /html\.detail-closing \.app-shell > :not\(\.detail-screen\):not\(\.app-toast-stack\) \*/);
});

test('afterPaint waits for two frames: the current one is painted before the work runs', () => {
  const { raf, flush } = fakeRaf();
  let ran = false;
  afterPaint(() => { ran = true; }, { raf });
  // 第一个 rAF 只是「下一帧渲染之前」：这一帧还没画出去。
  flush();
  assert.equal(ran, false);
  // 第二个 rAF：上一帧已经画出去了，现在才是卸层/恢复的安全时刻。
  flush();
  assert.equal(ran, true);
});

test('a dismissal holds the directory until the detail is gone and that frame is painted', () => {
  const steps = [];
  const { raf, flush } = fakeRaf();
  const dismiss = createDismissHandoff({
    addHold: () => steps.push('hold'),
    removeHold: () => steps.push('release'),
    unmount: () => steps.push('unmount'),
    raf,
  });

  dismiss();
  assert.deepEqual(steps, ['hold']);
  flush();
  flush();
  assert.deepEqual(steps, ['hold', 'unmount']);
  flush();
  flush();
  assert.deepEqual(steps, ['hold', 'unmount', 'release']);
});

test('overlapping dismissals keep the hold until the last one lands', () => {
  const steps = [];
  const { raf, flush } = fakeRaf();
  const dismiss = createDismissHandoff({
    addHold: () => steps.push('hold'),
    removeHold: () => steps.push('release'),
    unmount: () => steps.push('unmount'),
    raf,
  });

  dismiss();
  dismiss();
  flush();
  flush();
  flush();
  flush();
  assert.deepEqual(steps, ['hold', 'hold', 'unmount', 'unmount', 'release']);
});
