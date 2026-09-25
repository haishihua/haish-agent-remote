// 引用批注（桌面与 iOS 原生菜单都叫「Add Comment」）在**手机这一侧**的接线：
// 行的形状（chat-runtime.js 的 buildChatRows）与桌面那套模型层
// （../../haish-agent/app-web/src/features/chat/model/message-annotations.js）拼在一起对不对。
// 手机不复制桌面的模型，所以这里要钉的是「接线」而不是规则本身：桌面的
// useAnnotationDraft / ChatPanel 认的三个字段——`role`、`messageId`、`annotations`——
// 手机的行必须都有（少一个就会出现「发出去了草稿还在输入框里」或者引用块不显示）。
//
// 另外 `isSubmittedAnnotationMessage` 为真意味着桌面的行会画 `haish-sent-annotations`
// 那一段引用（ChatMessageRow 第 185 行），所以这条也是「发出去之后引用会不会显示在消息里」
// 的开关。
import './support/window-stub.mjs';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildChatRows } from '../src/chat-runtime.js';
import {
  isSubmittedAnnotationMessage,
  numberAnnotations,
  visibleAnnotationDrafts,
  withoutAcknowledgedAnnotations,
} from '../../haish-agent/app-web/src/features/chat/model/message-annotations.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('composer caret changes return before annotation capture or native bridge work', async () => {
  const source = await read('../src/message-annotations.jsx');
  assert.match(source, /if \(isEditableSelection\) \{[\s\S]*?return;[\s\S]*?if \(frameRef\.current\) return;/);
});

const ANNOTATION = {
  id: 'a1',
  source_message_id: 'm2',
  text: '，这就',
  comment: '这里要展开',
  start: 2,
  end: 5,
  prefix: '收到',
  suffix: '是回复。',
};

function taskSummary(extra = {}) {
  return {
    task_id: 'task-1',
    status: 'done',
    annotations: [ANNOTATION],
    user_message_id: 'm1',
    ...extra,
  };
}

test('一条已经发出去的引用：草稿让位给行，号码在整段会话里保持同一个', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [
      { message_id: 'm1', role: 'user', content: '看下这段引用', task_id: 'task-1' },
      { message_id: 'm2', role: 'assistant', content: '收到，这就是回复。', task_id: 'task-1' },
    ],
    tasksById: new Map([['task-1', taskSummary()]]),
  });

  // 行上带着这一轮的引用（桌面 ChatMessageRow 就是拿 `message.annotations` 画那段引用块）。
  assert.equal(rows[0].annotations.length, 1);
  assert.equal(isSubmittedAnnotationMessage(rows[0]), true);
  // 服务端快照认领之后，输入框里的草稿不该再留一份（桌面同一条规则）。
  assert.deepEqual(visibleAnnotationDrafts([ANNOTATION], rows), []);
  assert.deepEqual(withoutAcknowledgedAnnotations([ANNOTATION], rows), []);
  assert.equal(numberAnnotations(rows, []).get('a1'), 1);
});

test('乐观行（还没拿到 message_id）就能让草稿让位，编号不跳', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [],
    optimisticMessages: [{ id: 'pending-1', text: '看下这段引用', images: [], annotations: [ANNOTATION] }],
  });

  assert.equal(rows[0].annotations.length, 1);
  // 乐观行没有服务端 message_id：草稿不算「已确认」，但也不重复显示（这一轮的行已经背着它了）。
  assert.deepEqual(visibleAnnotationDrafts([ANNOTATION], rows), []);
  assert.deepEqual(withoutAcknowledgedAnnotations([ANNOTATION], rows), [ANNOTATION]);
  assert.equal(numberAnnotations(rows, []).get('a1'), 1);
});

test('发送途中改过的草稿不会被服务端快照认领', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [
      { message_id: 'm1', role: 'user', content: '看下这段引用', task_id: 'task-1' },
      { message_id: 'm2', role: 'assistant', content: '收到，这就是回复。', task_id: 'task-1' },
    ],
    tasksById: new Map([['task-1', taskSummary()]]),
  });
  const edited = [{ ...ANNOTATION, comment: '改了一句' }];

  // 快照里是旧的那一份：草稿留着（不能把用户刚敲的字吞了），而且仍在输入框里显示着——
  // 它是**下一次**发送要带上的那一份。
  assert.deepEqual(withoutAcknowledgedAnnotations(edited, rows), edited);
  assert.deepEqual(visibleAnnotationDrafts(edited, rows), edited);
});

test('编号按会话顺序排：先发出去的那条在前，手里的草稿接在后面', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [
      { message_id: 'm1', role: 'user', content: '看下这段引用', task_id: 'task-1' },
      { message_id: 'm2', role: 'assistant', content: '收到，这就是回复。', task_id: 'task-1' },
    ],
    tasksById: new Map([['task-1', taskSummary()]]),
  });
  const draft = { ...ANNOTATION, id: 'a2', text: '这就是回复', start: 3, end: 8, prefix: '，', suffix: '。' };

  const numbers = numberAnnotations(rows, [draft]);
  assert.equal(numbers.get('a1'), 1);
  assert.equal(numbers.get('a2'), 2);
});
