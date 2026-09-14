import assert from 'node:assert/strict';
import test from 'node:test';

import { orphanReplyAnchors, orphanTaskReplies } from '../src/task-replies.js';

test('cancelled and failed tasks without an assistant message become local replies', () => {
  const conversation = {
    tasks: [
      { task_id: 'task-1', status: 'done', assistant_message_id: 'message-2' },
      { task_id: 'task-2', status: 'cancelled', assistant_message_id: null, answer_text: 'partial' },
      { task_id: 'task-3', status: 'failed' },
      { task_id: 'task-4', status: 'running' },
      { task_id: 'task-5', status: 'done' },
    ],
    messages: [
      { message_id: 'message-1', role: 'user', task_id: 'task-1' },
      { message_id: 'message-2', role: 'assistant', task_id: 'task-1' },
      { message_id: 'message-3', role: 'user', task_id: 'task-2' },
      { message_id: 'message-4', role: 'user', task_id: 'task-4' },
      { message_id: 'message-5', role: 'user', task_id: 'task-5' },
    ],
  };

  const replies = orphanTaskReplies(conversation);
  assert.deepEqual([...replies.keys()], ['task-2', 'task-3']);
  assert.equal(replies.get('task-2').answer_text, 'partial');
});

test('a reply is anchored to the last user message of its task', () => {
  const replies = new Map([['task-2', { task_id: 'task-2', status: 'cancelled' }]]);
  const messages = [
    { message_id: 'message-1', role: 'user', task_id: 'task-1' },
    { message_id: 'message-2', role: 'user', task_id: 'task-2' },
    { message_id: 'message-3', role: 'assistant', task_id: 'task-1' },
    { message_id: 'message-4', role: 'user', task_id: 'task-2' },
  ];

  const anchors = orphanReplyAnchors(messages, replies);
  assert.deepEqual([...anchors.keys()], ['message-4']);
  assert.equal(anchors.get('message-4').task_id, 'task-2');
});

test('tasks that already render an assistant message are left untouched', () => {
  const conversation = {
    tasks: [{ task_id: 'task-1', status: 'cancelled', assistant_message_id: 'message-2' }],
    messages: [
      { message_id: 'message-1', role: 'user', task_id: 'task-1' },
      { message_id: 'message-2', role: 'assistant', task_id: 'task-1' },
    ],
  };

  assert.equal(orphanTaskReplies(conversation).size, 0);
  assert.equal(orphanReplyAnchors(conversation.messages, new Map()).size, 0);
});
