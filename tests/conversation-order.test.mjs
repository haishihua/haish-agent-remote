import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listTaskForConversation,
  runningConversationsFirst,
} from '../src/conversation-order.js';

test('running conversations float to the top of their project without disturbing group order', () => {
  const conversations = [
    { conversation_id: 'idle-2', sort_order: 2, tasks: [{ task_id: 'done', status: 'done' }] },
    { conversation_id: 'running-3', sort_order: 3, tasks: [{ task_id: 'run', status: 'running' }] },
    { conversation_id: 'idle-1', sort_order: 1, tasks: [] },
    { conversation_id: 'queued-4', sort_order: 4, tasks: [{ task_id: 'queue', status: 'queued' }] },
  ];

  assert.deepEqual(
    runningConversationsFirst(conversations).map((item) => item.conversation_id),
    ['running-3', 'queued-4', 'idle-1', 'idle-2'],
  );
  assert.deepEqual(conversations.map((item) => item.conversation_id), ['idle-2', 'running-3', 'idle-1', 'queued-4']);
});

test('completion markers override stale running status', () => {
  const conversation = {
    conversation_id: 'finished',
    last_task_id: 'stale',
    tasks: [{ task_id: 'stale', status: 'running', completed_at: '2026-09-02T00:00:00Z' }],
  };
  const tasks = { stale: { task_id: 'stale', status: 'running', completed_at: '2026-09-02T00:00:00Z' } };

  assert.equal(listTaskForConversation(conversation, tasks), tasks.stale);
  assert.deepEqual(
    runningConversationsFirst([{ conversation_id: 'idle', sort_order: 0 }, { ...conversation, sort_order: 1 }], tasks).map((item) => item.conversation_id),
    ['idle', 'finished'],
  );
});

test('task map is used when a project conversation has no embedded task list', () => {
  const conversations = [
    { conversation_id: 'idle', sort_order: 0 },
    { conversation_id: 'running', sort_order: 1, last_task_id: 'task-1' },
  ];
  const tasks = { 'task-1': { task_id: 'task-1', status: 'running' } };

  assert.deepEqual(
    runningConversationsFirst(conversations, tasks).map((item) => item.conversation_id),
    ['running', 'idle'],
  );
});
