// 手机端只剩下状态判据和 NDJSON 读取了——折叠执行记录那部分搬去了 chat-runtime.js
// （新测试在 tests/chat-runtime.test.mjs）。
import './support/window-stub.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { isCurrentTaskRunning, isFailureStatus, isTaskRunning, readNdjson } from '../src/task-stream.js';

test('只有 queued / running 算在跑', () => {
  assert.equal(isTaskRunning('running'), true);
  assert.equal(isTaskRunning('queued'), true);
  assert.equal(isTaskRunning({ status: 'running' }), true);
  assert.equal(isTaskRunning({ status: 'done' }), false);
  assert.equal(isTaskRunning({ status: 'cancelled' }), false);
  assert.equal(isTaskRunning(null), false);
  assert.equal(isTaskRunning(undefined), false);
});

test('失败判据认得取消、失败和报错三种落地', () => {
  assert.equal(isFailureStatus('cancelled'), true);
  assert.equal(isFailureStatus('failed'), true);
  assert.equal(isFailureStatus('error'), true);
  assert.equal(isFailureStatus({ status: 'Error' }), true);
  assert.equal(isFailureStatus({ status: 'done' }), false);
  assert.equal(isFailureStatus(''), false);
  assert.equal(isFailureStatus(null), false);
});

test('活动任务取实时运行的那份，否则取会话里记的那份', () => {
  assert.equal(isCurrentTaskRunning({ status: 'running' }, { status: 'done' }), true);
  assert.equal(isCurrentTaskRunning(null, { status: 'running' }), true);
  assert.equal(isCurrentTaskRunning(null, { status: 'done' }), false);
  assert.equal(isCurrentTaskRunning(null, null), false);
});

test('NDJSON reader emits complete events across response chunks', async () => {
  const source = [
    '{"type":"run_started"}\n{"type":"llm_answer_',
    'delta","payload":{"delta":"Hi"}}\n',
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of source) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
  const events = [];

  await readNdjson(response, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), ['run_started', 'llm_answer_delta']);
  assert.equal(events[1].payload.delta, 'Hi');
});

test('a trailing line without a newline is still delivered', async () => {
  const response = new Response('{"type":"run_started"}\n{"type":"run_finished"}');
  const events = [];

  await readNdjson(response, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), ['run_started', 'run_finished']);
});

test('a stream without a body is a real error, not a silent empty run', async () => {
  await assert.rejects(readNdjson({ body: null }, () => {}), { message: 'Task stream returned no response body.' });
});
