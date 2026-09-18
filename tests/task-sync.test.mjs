// 游标读：手机跟桌面用同一套（`after_event_id` + `events_delta`），缓存里存的是
// **桌面形状的 runtime task**（eventLog + 记录字段），折叠在 chat-runtime.js。
import './support/window-stub.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskRuntimeCache, createTaskRuntimeSync } from '../src/task-sync.js';

function delta(text, eventId, createdAt = '2026-09-17T00:00:00Z') {
  return { event_id: eventId, type: 'llm_answer_delta', payload: { delta: text }, created_at: createdAt };
}

function runtimeTask(taskId, events, extra = {}) {
  return { task_id: taskId, status: 'running', events, ...extra };
}

// 折出来的正文：相邻的 answer delta 合成一条，取它拼起来的那段。
function foldedText(task) {
  return (task?.eventLog || [])
    .filter((entry) => entry.type === 'llm_answer_delta')
    .map((entry) => entry.delta)
    .join('');
}

test('the first read folds the whole log and remembers its cursor', () => {
  const cache = createTaskRuntimeCache();
  assert.equal(cache.cursor('task-1'), null);
  assert.equal(cache.state('task-1'), null);

  const state = cache.remember(runtimeTask('task-1', [delta('A', 'e1'), delta('B', 'e2')]));

  assert.equal(foldedText(state), 'AB');
  assert.equal(state.status, 'running');
  assert.equal(state.runtimeHydrated, true);
  assert.equal(cache.cursor('task-1'), 'e2');
  assert.equal(cache.state('task-1'), state);
});

test('a confirmed cursor appends only the new events', () => {
  const cache = createTaskRuntimeCache();
  cache.remember(runtimeTask('task-1', [delta('A', 'e1')]));

  const appended = cache.remember({
    task_id: 'task-1',
    status: 'running',
    events_delta: true,
    events: [delta('B', 'e2'), delta('C', 'e3')],
  });

  assert.equal(foldedText(appended), 'ABC');
  assert.equal(appended.eventLog.length, 1);
  assert.equal(cache.cursor('task-1'), 'e3');
});

test('an appended delta folds exactly like a single full replay', () => {
  const events = [
    delta('He', 'e1'),
    delta('llo', 'e2'),
    { event_id: 'e3', type: 'todo_updated', payload: { items: [{ content: 'Ship it', status: 'in_progress' }] } },
    delta('!', 'e4'),
  ];
  const whole = createTaskRuntimeCache();
  const stepwise = createTaskRuntimeCache();

  const full = whole.remember(runtimeTask('task-1', events));
  stepwise.remember(runtimeTask('task-1', events.slice(0, 2)));
  const appended = stepwise.remember({
    task_id: 'task-1',
    status: 'running',
    events_delta: true,
    events: events.slice(2),
  });

  assert.equal(foldedText(appended), foldedText(full));
  assert.deepEqual(
    appended.eventLog.map((entry) => entry.type),
    full.eventLog.map((entry) => entry.type),
  );
  assert.equal(whole.cursor('task-1'), stepwise.cursor('task-1'));
});

test('a full replay replaces a trace whose cursor the runtime cannot resolve', () => {
  const cache = createTaskRuntimeCache();
  cache.remember(runtimeTask('task-1', [delta('stale', 'e1')]));

  const replaced = cache.remember({
    task_id: 'task-1',
    status: 'running',
    events_delta: false,
    events: [delta('fresh', 'e9')],
  });

  assert.equal(foldedText(replaced), 'fresh');
  assert.equal(cache.cursor('task-1'), 'e9');
});

test('a delta without anything cached still folds what it was given', () => {
  const cache = createTaskRuntimeCache();
  const state = cache.remember({
    task_id: 'task-1',
    status: 'running',
    events_delta: true,
    events: [delta('A', 'e1')],
  });
  assert.equal(foldedText(state), 'A');
  assert.equal(cache.cursor('task-1'), 'e1');
});

test('an idle delta poll hands back the object the UI already paints', () => {
  const cache = createTaskRuntimeCache();
  const first = cache.remember(runtimeTask('task-1', [delta('A', 'e1')]));

  const idle = cache.remember({ task_id: 'task-1', status: 'running', events_delta: true, events: [] });
  assert.equal(idle, first);
  assert.equal(cache.cursor('task-1'), 'e1');

  const finished = cache.remember({
    task_id: 'task-1',
    status: 'done',
    answer_text: 'A',
    events_delta: true,
    events: [],
  });
  assert.notEqual(finished, idle);
  assert.equal(finished.status, 'done');
  assert.equal(finished.answerText, 'A');
});

test('the cache stays bounded and drops the oldest task first', () => {
  const cache = createTaskRuntimeCache({ limit: 2 });
  cache.remember(runtimeTask('a', [delta('A', 'e-a')]));
  cache.remember(runtimeTask('b', [delta('B', 'e-b')]));
  cache.remember(runtimeTask('c', [delta('C', 'e-c')]));

  assert.equal(cache.size(), 2);
  assert.equal(cache.state('a'), null);
  assert.equal(cache.cursor('a'), null);
  assert.equal(cache.cursor('b'), 'e-b');
  assert.equal(cache.cursor('c'), 'e-c');
});

test('a payload without a task id is not cached', () => {
  const cache = createTaskRuntimeCache();
  assert.equal(cache.remember({ status: 'running', events: [] }), null);
  assert.equal(cache.size(), 0);
});

test('concurrent refreshes share one request and the follow-up carries the cursor', async () => {
  const calls = [];
  const responses = [];
  const sync = createTaskRuntimeSync({
    fetchTask: (taskId, { afterEventId }) => {
      calls.push({ taskId, afterEventId });
      return responses.shift();
    },
  });
  let releaseFirst;
  responses.push(new Promise((resolve) => { releaseFirst = resolve; }));

  const first = sync.refresh('task-1');
  const second = sync.refresh('task-1');
  await Promise.resolve();
  assert.equal(calls.length, 1);

  releaseFirst(runtimeTask('task-1', [delta('A', 'e1')]));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(foldedText(a), 'A');

  responses.push({
    task_id: 'task-1',
    status: 'running',
    events_delta: true,
    events: [delta('B', 'e2')],
  });
  const next = await sync.refresh('task-1');
  assert.equal(foldedText(next), 'AB');
  assert.deepEqual(calls.map((call) => call.afterEventId), [null, 'e1']);
});

test('a failed refresh backs off, then recovers on the first success', async () => {
  let now = 0;
  let failing = true;
  const attempts = [];
  const sync = createTaskRuntimeSync({
    now: () => now,
    retryMs: 2_000,
    maxRetryMs: 8_000,
    fetchTask: async (taskId) => {
      attempts.push(now);
      if (failing) throw new Error('boom');
      return runtimeTask(taskId, [delta('A', 'e1')]);
    },
  });

  await assert.rejects(sync.refresh('task-1'), { message: 'boom' });
  assert.equal(await sync.refresh('task-1'), null);
  now = 1_999;
  assert.equal(await sync.refresh('task-1'), null);

  now = 2_000;
  await assert.rejects(sync.refresh('task-1'), { message: 'boom' });
  now = 5_999;
  assert.equal(await sync.refresh('task-1'), null);

  now = 6_000;
  await assert.rejects(sync.refresh('task-1'), { message: 'boom' });
  now = 13_999;
  assert.equal(await sync.refresh('task-1'), null);

  now = 14_000;
  failing = false;
  const recovered = await sync.refresh('task-1');
  assert.equal(foldedText(recovered), 'A');
  assert.deepEqual(attempts, [0, 2_000, 6_000, 14_000]);

  // A success clears the backoff, so the next failure waits the base delay again.
  failing = true;
  now = 20_000;
  await assert.rejects(sync.refresh('task-1'), { message: 'boom' });
  assert.equal(await sync.refresh('task-1'), null);
  now = 22_000;
  await assert.rejects(sync.refresh('task-1'), { message: 'boom' });
  assert.deepEqual(attempts.slice(-2), [20_000, 22_000]);
});

test('a blank task id never reaches the network', async () => {
  let calls = 0;
  const sync = createTaskRuntimeSync({ fetchTask: async () => { calls += 1; } });
  assert.equal(await sync.refresh(''), null);
  assert.equal(await sync.refresh(null), null);
  assert.equal(calls, 0);
});
