import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_HISTORY_KEY,
  conversationHistoryState,
  conversationIdFromHistory,
  popConversationHistory,
  pushConversationHistory,
  replaceConversationHistory,
  replacePendingConversationHistory,
} from '../src/conversation-navigation.js';

function fakeHistory(initialState = null) {
  return {
    state: initialState,
    pushes: [],
    replacements: [],
    backCount: 0,
    pushState(state, _title, url) {
      this.state = state;
      this.pushes.push({ state, url });
    },
    replaceState(state, _title, url) {
      this.state = state;
      this.replacements.push({ state, url });
    },
    back() { this.backCount += 1; },
  };
}

test('conversation history preserves unrelated state and can clear only its own key', () => {
  const state = { router: 'keep', [CONVERSATION_HISTORY_KEY]: 'old' };
  assert.deepEqual(conversationHistoryState(state, 'next'), {
    router: 'keep',
    [CONVERSATION_HISTORY_KEY]: 'next',
  });
  assert.deepEqual(conversationHistoryState(state, ''), { router: 'keep' });
  assert.deepEqual(state, { router: 'keep', [CONVERSATION_HISTORY_KEY]: 'old' });
});

test('opening a conversation creates exactly one native back destination', () => {
  const history = fakeHistory({ router: 'keep' });
  assert.equal(pushConversationHistory(history, 'conversation-1', 'haish://app/'), true);
  assert.equal(conversationIdFromHistory(history.state), 'conversation-1');
  assert.equal(pushConversationHistory(history, 'conversation-1', 'haish://app/'), false);
  assert.equal(history.pushes.length, 1);
});

test('a pending create is replaced only while its history entry is still active', () => {
  const history = fakeHistory({ shell: 'kept' });
  pushConversationHistory(history, 'pending-1', '/remote');

  assert.equal(replacePendingConversationHistory(history, 'pending-1', 'conversation-new', '/remote'), true);
  assert.deepEqual(history.state, { shell: 'kept', [CONVERSATION_HISTORY_KEY]: 'conversation-new' });

  history.state = { shell: 'kept' };
  assert.equal(replacePendingConversationHistory(history, 'pending-1', 'conversation-late', '/remote'), false);
  assert.deepEqual(history.state, { shell: 'kept' });
});

test('back only runs while the current history entry owns the open detail', () => {
  const history = fakeHistory({ [CONVERSATION_HISTORY_KEY]: 'conversation-1' });
  assert.equal(popConversationHistory(history, 'conversation-1'), true);
  assert.equal(history.backCount, 1);
  assert.equal(popConversationHistory(history, 'conversation-2'), false);
  assert.equal(history.backCount, 1);
});

test('startup replaces a stale detail entry with the live list root', () => {
  const history = fakeHistory({ router: 'keep', [CONVERSATION_HISTORY_KEY]: 'stale' });
  replaceConversationHistory(history, '', 'haish://app/');
  assert.deepEqual(history.state, { router: 'keep' });
  assert.equal(history.replacements.length, 1);
});
