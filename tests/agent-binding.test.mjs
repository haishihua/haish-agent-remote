import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationHasSentMessage } from '../src/agent-binding.js';

test('a conversation that never sent anything keeps the agent selectable', () => {
  assert.equal(conversationHasSentMessage({ tasks: [], messages: [] }), false);
  assert.equal(conversationHasSentMessage(), false);
  assert.equal(conversationHasSentMessage({ tasks: null, messages: null }), false);
});

test('a task the runtime accepted locks the agent', () => {
  assert.equal(conversationHasSentMessage({ tasks: [{ task_id: 'a' }] }), true);
  assert.equal(conversationHasSentMessage({ tasks: [{ task_id: 'a' }], messages: [] }), true);
});

test('a user turn on the timeline locks the agent even before the task shows up', () => {
  assert.equal(conversationHasSentMessage({ messages: [{ role: 'user', id: 'm1' }] }), true);
  assert.equal(conversationHasSentMessage({ messages: [{ role: 'assistant', id: 'm1' }] }), false);
});

test('a brand-new conversation keeps the agent selectable even though it is not bound yet', () => {
  // The live payload of a conversation created by “New task”, before its first run: no
  // tasks, no messages, and no agent binding for the runtime to freeze.
  const fresh = {
    conversation_id: '1224fc2c3f9f441e9fba1edf6e1f8a66',
    title: 'New task',
    execution_mode: 'chat',
    agent_id: null,
    profile_id: null,
    profile_display_name: null,
    tasks: [],
    messages: [],
  };
  assert.equal(conversationHasSentMessage(fresh), false);
});
