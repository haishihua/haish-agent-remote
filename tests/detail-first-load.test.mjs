// 「首次打开会话偶发整屏空白，退出去再进又好了」这条。
//
// 目录里每一行都只有 `message_count`，**不带 messages**（runtime 的 /api/projects 就是这么给的），
// 所以进会话时线程本来是空的，全靠挂载后那一次 `api.conversation(id)` 填。这一次请求被
// `threadBusy()`（下拉手势 / 键盘动画 / 输入中）挤掉，就要等 15 秒的轮询——用户看到的是
// 一片空白，退回列表再进（重新挂载，这一轮不再撞上键盘动画）又正常，正是他描述的症状。
//
// 这里钉三件事：
//   1. 首屏（还没 hydrate）取会话不许让路；
//   2. 首屏落空要快速退避重试，不能干等轮询；
//   3. hydrate 之前线程区得有加载态，不能是一块看不见的黑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIRST_LOAD_RETRY_LIMIT, FIRST_LOAD_RETRY_MS, defersConversationFetch, firstLoadRetryDelay } from '../src/detail-load.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8');

test('首屏不让路：还没 hydrate 时手势/键盘拦住的不该是这一次取会话', () => {
  // 第一次进会话：keyboard 正在收起（刚在搜索框里打完字就点了那一行）——这是复现条件。
  assert.equal(defersConversationFetch({ hydrated: false, keep: false, busy: true }), false);
  assert.equal(defersConversationFetch({ hydrated: false, keep: false, busy: false }), false);
});

test('轮询仍然让路：hydrate 之后手势/键盘期间照旧跳过这一轮', () => {
  assert.equal(defersConversationFetch({ hydrated: true, keep: false, busy: true }), true);
  assert.equal(defersConversationFetch({ hydrated: true, keep: false, busy: false }), false);
  // 下拉刷新本身就是那个手势，不能把自己挡掉。
  assert.equal(defersConversationFetch({ hydrated: true, keep: true, busy: true }), false);
  // 缺参数不能抛（首屏链路里可能出现 undefined）。
  assert.equal(defersConversationFetch(), false);
});

test('首屏重试是有限次退避，之后交回 15 秒轮询', () => {
  const delays = Array.from({ length: FIRST_LOAD_RETRY_LIMIT + 2 }, (_, attempt) => firstLoadRetryDelay(attempt));
  assert.deepEqual(delays, [700, 1400, 2800, 5600, 0, 0]);
  assert.equal(FIRST_LOAD_RETRY_MS, 700);
  // 脏输入只当「不再重试」，不能变成 NaN 计时器。
  assert.equal(firstLoadRetryDelay(-1), 0);
  assert.equal(firstLoadRetryDelay(Number.NaN), 0);
  assert.equal(firstLoadRetryDelay(undefined), 0);
});

test('App.jsx 的两处让路判定都走同一个例外规则', async () => {
  const source = await read('src/App.jsx');
  const guard = /if \(defersConversationFetch\(\{ hydrated: conversationHydratedRef\.current, keep, busy: threadBusy\(\) \}\)\) return null;/g;
  assert.equal((source.match(guard) || []).length, 2, 'fetch 前后两处都要用 defersConversationFetch');
  assert.doesNotMatch(source, /if \(!keep && threadBusy\(\)\) return null;/, '旧的无条件让路不能留下');
  // ref 与 state 必须保持一致，否则首屏那条链读不到「已经拿到了」。
  assert.match(source, /conversationHydratedRef\.current = false;/);
  assert.match(source, /conversationHydratedRef\.current = true;\s*\n\s*setConversationHydrated\(true\);/);
});

test('App.jsx 首屏那条链会重试，而不是只发一次', async () => {
  const source = await read('src/App.jsx');
  assert.match(source, /const delay = firstLoadRetryDelay\(attempts\);/);
  assert.match(source, /retry = window\.setTimeout\(load, delay\);/);
  assert.match(source, /if \(cancelled \|\| loaded \|\| conversationHydratedRef\.current\) return;/);
  // 卸载/换会话要把重试链停掉，别让旧会话的请求继续排。
  assert.match(source, /cancelled = true;\s*\n\s*window\.clearTimeout\(retry\);/);
});

test('hydrate 之前线程区画加载态（否则首次进会话就是整屏空白）', async () => {
  const source = await read('src/App.jsx');
  assert.match(
    source,
    /\{!conversationHydrated && !detailLoadFailed && !rows\.length \? <div className="center-state"><LoaderCircle className="spin" \/><span>Loading conversation…<\/span><\/div> : null\}/,
  );
});
