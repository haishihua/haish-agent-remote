import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  THREAD_WINDOW_ROWS,
  THREAD_WINDOW_STEP,
  extendThreadWindow,
  rowsToReveal,
  threadWindowStart,
} from '../src/thread-window.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the window keeps only the newest rows of a long thread', () => {
  assert.equal(threadWindowStart(10, THREAD_WINDOW_ROWS), 0);
  assert.equal(threadWindowStart(500, THREAD_WINDOW_ROWS), 500 - THREAD_WINDOW_ROWS);
  assert.equal(threadWindowStart(500, 80), 420);
  assert.equal(threadWindowStart(0, THREAD_WINDOW_ROWS), 0);
  // 窗口大小被写坏时也不能把线程停在半路。
  assert.equal(threadWindowStart(30, 0), 29);
});

test('an annotation jump asks for the rows it needs to reach its target', () => {
  const rows = [{ id: 'a' }, { id: 'b', messageId: 'msg-b' }, { id: 'c' }];

  assert.equal(rowsToReveal(rows, 'a'), 3);
  assert.equal(rowsToReveal(rows, 'msg-b'), 2);
  assert.equal(rowsToReveal(rows, 'c'), 1);
  assert.equal(rowsToReveal(rows, 'missing'), 0);
  assert.equal(rowsToReveal(rows, ''), 0);
});

test('loading an earlier window keeps the reader where they were', () => {
  const frames = [];
  let stored = 0;
  const scroller = { scrollTop: 100, scrollHeight: 1000 };

  const before = extendThreadWindow({
    scroller,
    step: THREAD_WINDOW_STEP,
    setSize: (update) => { stored = update(stored); },
    frame: (callback) => { frames.push(callback); },
  });

  assert.equal(before, 1000);
  assert.equal(stored, THREAD_WINDOW_STEP);
  // 更早的那一段还没挂上：这一帧先不动滚动位置。
  assert.equal(scroller.scrollTop, 100);

  scroller.scrollHeight = 1400;
  frames.forEach((callback) => callback());
  // 补进来的是视野上方的内容：滚动位置补回同样的像素，正在读的那一段没有往下跳。
  assert.equal(scroller.scrollTop, 500);
});

test('the thread window is wired into the detail screen', async () => {
  const [app, css] = await Promise.all([read('../src/App.jsx'), read('../src/styles.css')]);

  // iOS 17 的 WebKit 没有 content-visibility（Safari 18 才有）：行数只能自己控。
  assert.match(css, /\.chat-row \{ content-visibility: auto;/);
  assert.match(app, /const \[threadWindow, setThreadWindow\] = useState\(THREAD_WINDOW_ROWS\)/);
  assert.match(app, /setThreadWindow\(THREAD_WINDOW_ROWS\)/);
  assert.match(app, /const hiddenRowCount = threadWindowStart\(rows\.length, threadWindow\)/);
  assert.match(app, /const threadRows = hiddenRowCount > 0 \? rows\.slice\(hiddenRowCount\) : rows/);
  assert.match(app, /rows=\{threadRows\}/);

  // 收起来的那一段由顶部按钮叫回来（补齐后的滚动补偿在 thread-window.js 里）。
  assert.match(app, /className="thread-more" onClick=\{showEarlierMessages\}/);
  assert.match(app, /extendThreadWindow\(\{ scroller: messageScrollRef\.current, setSize: setThreadWindow \}\)/);
  assert.match(app, /const needed = rowsToReveal\(rowsRef\.current/);
  assert.match(app, /requestAnimationFrame\(\(\) => annotationUiRef\.current\?\.jump\(item\)\)/);

  // 行的模型（引用编号、审批插槽）还是整份会话，只有渲染被窗口裁。
  assert.match(app, /const annotationMessages = useMemo\(\(\) => selectAnnotationMessages\(rows, id\)/);
  assert.match(css, /\.thread-more \{/);
});
