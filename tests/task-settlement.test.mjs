import assert from 'node:assert/strict';
import test from 'node:test';

import { persistedAssistantForTask, waitForPersistedAssistant } from '../src/task-settlement.js';

const conversation = (messages = []) => ({ conversation_id: 'c1', messages });

test('persisted assistant matching is scoped to the completed task', () => {
  const payload = conversation([
    { role: 'user', task_id: 'task-1', content: 'go' },
    { role: 'assistant', task_id: 'task-2', content: 'other answer' },
    { role: 'assistant', task_id: 'task-1', content: 'final summary' },
  ]);
  assert.equal(persistedAssistantForTask(payload, 'task-1')?.content, 'final summary');
  assert.equal(persistedAssistantForTask(payload, 'missing'), null);
});

test('settlement retries until the final assistant message is durable', async () => {
  const snapshots = [
    conversation([{ role: 'user', task_id: 'task-1', content: 'go' }]),
    conversation([{ role: 'user', task_id: 'task-1', content: 'go' }]),
    conversation([
      { role: 'user', task_id: 'task-1', content: 'go' },
      { role: 'assistant', task_id: 'task-1', content: 'final summary' },
    ]),
  ];
  const waits = [];
  let calls = 0;
  const settled = await waitForPersistedAssistant({
    taskId: 'task-1',
    delays: [0, 10, 20, 40],
    sleep: async (delay) => { waits.push(delay); },
    refresh: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(persistedAssistantForTask(settled, 'task-1')?.content, 'final summary');
});

test('settlement returns the latest snapshot after the retry window', async () => {
  let calls = 0;
  const latest = await waitForPersistedAssistant({
    taskId: 'task-1',
    delays: [0, 1, 1],
    sleep: async () => {},
    refresh: async () => conversation([{ role: 'user', task_id: 'task-1', content: String(++calls) }]),
  });
  assert.equal(calls, 3);
  assert.equal(latest.messages[0].content, '3');
});
