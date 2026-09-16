import test from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationOrderTimestamp,
  isTaskActuallyActive,
  listTaskForConversation,
  orderConversations,
  orderProjects,
  runningTaskForConversation,
} from '../src/conversation-order.js';

function ids(conversations, tasks) {
  return orderConversations(conversations, tasks).map((item) => item.conversation_id);
}

test('conversations rank pinned, then running, then the newest real activity — the desktop order', () => {
  const conversations = [
    {
      conversation_id: 'settled-recent',
      sort_order: 6,
      tasks: [{ task_id: 't1', status: 'done', created_at: '2026-09-16T09:00:00Z', completed_at: '2026-09-16T09:30:00Z' }],
    },
    {
      conversation_id: 'running-older',
      sort_order: 7,
      tasks: [{ task_id: 't2', status: 'running', created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T10:30:00Z' }],
    },
    {
      conversation_id: 'pinned-idle',
      pinned: true,
      sort_order: 9,
      tasks: [{ task_id: 't3', status: 'done', created_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-02T00:00:00Z' }],
    },
    {
      conversation_id: 'settled-old',
      sort_order: 1,
      tasks: [{ task_id: 't4', status: 'done', created_at: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T01:00:00Z' }],
    },
  ];

  assert.deepEqual(ids(conversations), ['pinned-idle', 'running-older', 'settled-recent', 'settled-old']);
});

test('a running task ranks on when it started, so streamed updates cannot reshuffle the list', () => {
  const conversations = [
    {
      conversation_id: 'started-earlier',
      sort_order: 0,
      tasks: [{ task_id: 'a', status: 'running', created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T10:40:00Z' }],
    },
    {
      conversation_id: 'started-later',
      sort_order: 1,
      tasks: [{ task_id: 'b', status: 'running', created_at: '2026-09-16T10:05:00Z', updated_at: '2026-09-16T10:06:00Z' }],
    },
  ];

  assert.deepEqual(ids(conversations), ['started-later', 'started-earlier']);

  // Later chunks rewrite updated_at; the order must not move.
  conversations[0].tasks[0].updated_at = '2026-09-16T10:59:00Z';
  assert.deepEqual(ids(conversations), ['started-later', 'started-earlier']);
});

test('settled conversations rank by when they settled, and the sort is stable', () => {
  const newer = {
    conversation_id: 'newer',
    sort_order: 9,
    tasks: [{ task_id: 'n', status: 'done', created_at: '2026-09-16T08:00:00Z', completed_at: '2026-09-16T08:30:00Z' }],
  };
  const older = {
    conversation_id: 'older',
    sort_order: 0,
    tasks: [{ task_id: 'o', status: 'cancelled', created_at: '2026-09-16T07:00:00Z', completed_at: '2026-09-16T07:10:00Z' }],
  };

  assert.deepEqual(ids([older, newer]), ['newer', 'older']);
  assert.deepEqual(ids([newer, older]), ['newer', 'older']);
});

test('conversations without a task rank on their timestamp, then on the stored sort order', () => {
  assert.deepEqual(ids([
    { conversation_id: 'no-task-older', sort_order: 4, updated_at: '2026-09-16T10:00:00Z' },
    { conversation_id: 'no-task', sort_order: 3, updated_at: '2026-09-16T11:00:00Z' },
  ]), ['no-task', 'no-task-older']);

  // Same activity: the desktop falls back to the stored order, not the input order.
  assert.deepEqual(ids([
    { conversation_id: 'tie-5', sort_order: 5, updated_at: '2026-09-16T11:00:00Z' },
    { conversation_id: 'tie-2', sort_order: 2, updated_at: '2026-09-16T11:00:00Z' },
  ]), ['tie-2', 'tie-5']);
});

test('the polled task map wins over the stale task embedded in the directory listing', () => {
  const conversation = {
    conversation_id: 'fresh',
    last_task_id: 'task-1',
    sort_order: 0,
    tasks: [{ task_id: 'task-1', status: 'done', created_at: '2026-09-16T09:00:00Z', completed_at: '2026-09-16T09:10:00Z' }],
  };
  const settledLater = {
    conversation_id: 'settled-later',
    sort_order: 1,
    tasks: [{ task_id: 'task-9', status: 'done', created_at: '2026-09-16T09:00:00Z', completed_at: '2026-09-16T09:30:00Z' }],
  };
  const tasks = {
    'task-1': { task_id: 'task-1', status: 'running', created_at: '2026-09-16T09:00:00Z', updated_at: '2026-09-16T09:20:00Z' },
  };

  assert.equal(runningTaskForConversation(conversation, tasks)?.task_id, 'task-1');
  assert.deepEqual(ids([settledLater, conversation], tasks), ['fresh', 'settled-later']);
});

test('a last task the directory did not embed still counts for ordering', () => {
  const conversation = { conversation_id: 'orphan-last', last_task_id: 'task-7', sort_order: 4 };
  const tasks = { 'task-7': { task_id: 'task-7', status: 'done', created_at: '2026-09-16T12:00:00Z', completed_at: '2026-09-16T12:05:00Z' } };

  assert.equal(listTaskForConversation(conversation, tasks)?.task_id, 'task-7');
  assert.equal(
    conversationOrderTimestamp(conversation, tasks),
    Date.parse('2026-09-16T12:05:00Z'),
  );
  assert.deepEqual(ids([conversation, { conversation_id: 'quiet', sort_order: 1, updated_at: '2026-09-16T11:00:00Z' }], tasks), ['orphan-last', 'quiet']);
});

test('projects rank pinned first, then by the stored sort order', () => {
  const projects = [
    { project_id: 'plain-2', pinned: false, sort_order: 2 },
    { project_id: 'plain-0', pinned: false, sort_order: 0 },
    { project_id: 'pinned-4', pinned: true, sort_order: 4 },
    { project_id: 'pinned-1', pinned: true, sort_order: 1 },
  ];

  assert.deepEqual(
    orderProjects(projects).map((project) => project.project_id),
    ['pinned-1', 'pinned-4', 'plain-0', 'plain-2'],
  );
});

test('every runtime terminal status releases the phone, only queued and running stay active', () => {
  for (const status of ['done', 'failed', 'cancelled']) {
    assert.equal(isTaskActuallyActive({ task_id: 'task-1', status }), false, status);
  }
  assert.equal(isTaskActuallyActive({ task_id: 'task-1', status: 'queued' }), true);
  assert.equal(isTaskActuallyActive({ task_id: 'task-1', status: 'running' }), true);

  const conversations = ['done', 'failed', 'cancelled'].map((status, index) => ({
    conversation_id: `idle-${status}`,
    sort_order: index,
    tasks: [{ task_id: `task-${status}`, status, created_at: '2026-09-16T10:00:00Z', completed_at: '2026-09-16T10:00:00Z' }],
  }));
  assert.deepEqual(ids(conversations), ['idle-done', 'idle-failed', 'idle-cancelled']);
});

test('completion markers override stale running status', () => {
  const conversation = {
    conversation_id: 'finished',
    last_task_id: 'stale',
    tasks: [{ task_id: 'stale', status: 'running', completed_at: '2026-09-02T00:00:00Z' }],
  };
  const tasks = { stale: { task_id: 'stale', status: 'running', completed_at: '2026-09-02T00:00:00Z' } };

  assert.equal(listTaskForConversation(conversation, tasks), tasks.stale);
  // The conversation that actually ran something outranks one with no recorded
  // activity at all, even though its only task looks stale to the runtime.
  assert.deepEqual(
    ids([{ conversation_id: 'idle', sort_order: 0 }, { ...conversation, sort_order: 1 }], tasks),
    ['finished', 'idle'],
  );
});
