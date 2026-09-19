import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.js';

// 桌面的模型模块在 import 那一刻就会读 `window.HAISH_API_BASE`（浏览器里才有），Node 下补一个空壳：
// 这里只用它那两个纯函数（占位名判据、一句话摘要）。
globalThis.window = { HAISH_API_BASE: '' };
const {
  NEW_CONVERSATION_TITLE,
  conversationTitleForMessage,
  isPlaceholderConversationTitle,
} = await import('../src/conversation-title.js');

test('a conversation opens with a name both clients treat as a placeholder', () => {
  assert.equal(NEW_CONVERSATION_TITLE, 'New Chat');
  assert.equal(isPlaceholderConversationTitle(NEW_CONVERSATION_TITLE), true);
  // 桌面自己建会话时写的默认名：手机在它建的会话里发第一条消息也要能换掉。
  assert.equal(isPlaceholderConversationTitle('Default Session'), true);
  assert.equal(isPlaceholderConversationTitle('New Chat 3'), true);
  // 用户自己起过的名字不动。
  assert.equal(isPlaceholderConversationTitle('修一下键盘'), false);
  assert.equal(isPlaceholderConversationTitle(''), false);
  assert.equal(isPlaceholderConversationTitle(undefined), false);
});

test('the create call writes exactly the name the placeholder check knows', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_path, init = {}) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ conversation_id: 'abc', title: requestBody.title }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await api.createConversation('project-1');
    assert.equal(requestBody.title, NEW_CONVERSATION_TITLE);
    assert.equal(isPlaceholderConversationTitle(requestBody.title), true);
    assert.deepEqual(requestBody, { title: NEW_CONVERSATION_TITLE, execution_mode: 'chat', project_id: 'project-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the first message names the conversation with the desktop one-liner', () => {
  // 空白折叠；空白 / 纯图片那一轮带不起名字（调用方跳过换名）。
  assert.equal(conversationTitleForMessage('  修一下   键盘  '), '修一下 键盘');
  assert.equal(conversationTitleForMessage(''), '');
  assert.equal(conversationTitleForMessage('   \n  '), '');
  // 桌面是 48 字截断（末尾省略号也算进去）。
  const long = '长'.repeat(60);
  const title = conversationTitleForMessage(long);
  assert.equal(Array.from(title).length, 48);
  assert.equal(title.endsWith('…'), true);
  assert.equal(conversationTitleForMessage(long.slice(0, 48)), long.slice(0, 48));
});
