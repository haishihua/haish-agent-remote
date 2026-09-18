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
  assert.match(css, /html\.detail-closing \.app-shell > :not\(\.detail-screen\) \*/);
});

test('a swipe dismissal leaves the directory live but still schedules the unmount', () => {
  const steps = [];
  const { raf, flush } = fakeRaf();
  const dismiss = createDismissHandoff({
    addHold: () => steps.push('hold'),
    removeHold: () => steps.push('release'),
    unmount: () => steps.push('unmount'),
    raf,
  });

  dismiss({ hold: false });
  assert.deepEqual(steps, []);
  flush();
  flush();
  // 排期照旧：动画最后那一帧先画出去，再卸层；只是不再拿 detail-closing 把目录冻两帧。
  assert.deepEqual(steps, ['unmount']);
  flush();
  flush();
  assert.deepEqual(steps, ['unmount']);
});

test('styles.css hands the directory back on release, and keeps it frozen while the finger is down', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const release = css.match(/\.app-shell\.detail-open:has\(\.detail-screen\.swipe-dismissing\)[^{]*\{[^}]*\}/g) || [];
  assert.equal(release.length, 2);
  const joined = release.join('\n');
  // 目录的定时动画与顶栏模糊都在松手那一下回来（:has(swipe-dismissing)），而不是等收尾动画彻底结束。
  assert.match(joined, /> :not\(\.detail-screen\) \* \{ animation-play-state: running; \}/);
  assert.match(joined, /backdrop-filter: var\(--topbar-backdrop\)/);
  // 手指还按着（只有 detail-open）时两样都是关的：拖动里恢复等于每帧重算一次模糊、每行重算一次样式。
  assert.match(css, /\.app-shell\.detail-open \.remote-topbar \{ backdrop-filter: none; \}/);
  // hold 不再自己关模糊：它是按钮返回那条路的（那条路不传 keepDirectoryLive）。
  assert.doesNotMatch(css, /html\.detail-closing \.remote-topbar/);
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
