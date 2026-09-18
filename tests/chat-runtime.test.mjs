// chat-runtime.js 是手机端接桌面 chat 执行 UI 的数据接缝：三条入口（详情/游标轮询、
// NDJSON 流、本地草稿）都折成桌面形状的 runtime task，行由 buildChatRows 拼。
import './support/window-stub.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatRows,
  draftRuntimeTask,
  replyText,
  runtimeTaskFromDetail,
  runtimeTaskFromSummary,
  runtimeTaskWithEvent,
} from '../src/chat-runtime.js';
import { orphanReplyAnchors, orphanTaskReplies } from '../src/task-replies.js';

const AGENT_OPTIONS = [{ id: 'preset.general', label: 'General' }];

function rawEvent(id, type, payload = {}, extra = {}) {
  return { event_id: id, type, payload, created_at: `2026-09-19T00:00:0${id.slice(1)}Z`, ...extra };
}

function detail(events, extra = {}) {
  return {
    task_id: 'task-1',
    conversation_id: 'convo-1',
    status: 'running',
    created_at: '2026-09-19T00:00:00Z',
    events,
    ...extra,
  };
}

function answerDeltas(...texts) {
  return texts.map((text, index) => rawEvent(`e${index + 1}`, 'llm_answer_delta', { delta: text }));
}

test('a full detail replay folds into the desktop runtime task shape', () => {
  const task = runtimeTaskFromDetail(detail([
    rawEvent('e1', 'run_started'),
    rawEvent('e2', 'llm_thinking_delta', { delta: 'hmm' }),
    ...answerDeltas('Hel', 'lo'),
    rawEvent('e5', 'tool_call_started', { call_id: 'c9', tool_name: 'exec_command', tool_input: { command: 'ls' } }),
    rawEvent('e6', 'tool_call_completed', { call_id: 'c9', tool_name: 'exec_command', output_summary: 'ok' }),
  ]));

  assert.equal(task.taskId, 'task-1');
  assert.equal(task.conversationId, 'convo-1');
  assert.equal(task.runtimeHydrated, true);
  assert.deepEqual(
    task.eventLog.map((entry) => entry.type),
    ['run_started', 'llm_thinking_delta', 'llm_answer_delta', 'tool_call_started', 'tool_call_completed'],
  );
  // 相邻的同类 delta 合并成一条：流式时时间线还走桌面的增量路径，不会一路堆节点。
  assert.equal(task.eventLog[2].delta, 'Hello');
  assert.equal(task.eventLog[3].callId, 'c9');
});

test('a cursor detail appends to the log it already folded', () => {
  const first = runtimeTaskFromDetail(detail(answerDeltas('Hel')));
  const second = runtimeTaskFromDetail(
    detail([rawEvent('e2', 'llm_answer_delta', { delta: 'lo' })], { events_delta: true }),
    first,
  );

  assert.equal(second.eventLog.length, 1);
  assert.equal(second.eventLog[0].delta, 'Hello');
  assert.equal(second.runtimeHydrated, true);
});

test('a full replay replaces a log the cursor cannot be trusted on', () => {
  const stale = runtimeTaskFromDetail(detail(answerDeltas('stale')));
  const fresh = runtimeTaskFromDetail(
    detail([rawEvent('e9', 'llm_answer_delta', { delta: 'fresh' })], { events_delta: false }),
    stale,
  );

  assert.equal(fresh.eventLog.length, 1);
  assert.equal(fresh.eventLog[0].delta, 'fresh');
});

test('stream events fold one at a time and carry the task id they arrive with', () => {
  const draft = draftRuntimeTask(1_700_000_000_000);
  assert.equal(draft.taskId, null);

  const started = runtimeTaskWithEvent(draft, {
    type: 'run_started',
    task_id: 'task-9',
    conversation_id: 'convo-9',
    event_id: 'e1',
  });
  assert.equal(started.taskId, 'task-9');
  assert.equal(started.conversationId, 'convo-9');
  assert.equal(started.status, 'running');

  const streamed = runtimeTaskWithEvent(
    runtimeTaskWithEvent(started, { type: 'llm_answer_delta', payload: { delta: 'He' }, event_id: 'e2' }),
    { type: 'llm_answer_delta', payload: { delta: 'y' }, event_id: 'e3' },
  );
  assert.equal(streamed.eventLog.length, 2);
  assert.equal(streamed.eventLog[1].delta, 'Hey');
  // 原对象不能被就地改：实时行那边是靠新对象触发重画的。
  assert.equal(started.eventLog.length, 1);
});

test('an event-less payload leaves the task alone', () => {
  const task = draftRuntimeTask();
  assert.equal(runtimeTaskWithEvent(task, { type: '' }), task);
  assert.equal(runtimeTaskWithEvent(null, { type: 'run_started' }), null);
});

test('a conversation summary keeps the log folded from the earlier detail read', () => {
  const hydrated = runtimeTaskFromDetail(detail(answerDeltas('Hello')));
  const summary = runtimeTaskFromSummary({
    task_id: 'task-1',
    conversation_id: 'convo-1',
    status: 'done',
    created_at: '2026-09-19T00:00:00Z',
    completed_at: '2026-09-19T00:00:10Z',
    answer_text: 'Hello',
  }, hydrated);

  assert.equal(summary.status, 'done');
  assert.equal(summary.answerText, 'Hello');
  assert.equal(summary.runtimeHydrated, true);
  assert.equal(summary.eventLog.length, 1);
  assert.equal(summary.eventLog[0].delta, 'Hello');
});

test('a summary without a task id falls back to what was already on screen', () => {
  const hydrated = runtimeTaskFromDetail(detail(answerDeltas('Hello')));
  assert.equal(runtimeTaskFromSummary({ status: 'running' }, hydrated), hydrated);
  assert.equal(runtimeTaskFromSummary(null, null), null);
});

test('the thread is messages in order, with the desktop timeline on the agent row', () => {
  const runtime = runtimeTaskFromDetail(detail([
    rawEvent('e1', 'llm_thinking_delta', { delta: 'hmm' }),
    ...answerDeltas('Hel', 'lo'),
    rawEvent('e4', 'tool_call_started', { call_id: 'c9', tool_name: 'exec_command', tool_input: { command: 'ls' } }),
    rawEvent('e5', 'todo_updated', { items: [{ content: 'Ship it', status: 'in_progress' }] }),
  ]));

  const rows = buildChatRows({
    conversationId: 'convo-1',
    conversation: { agent_id: 'preset.general' },
    messages: [
      { message_id: 'm1', role: 'user', content: 'do it', task_id: 'task-1', created_at: '2026-09-19T00:00:00Z' },
      { message_id: 'm2', role: 'assistant', content: 'done', task_id: 'task-1', created_at: '2026-09-19T00:00:09Z' },
    ],
    tasksById: new Map([['task-1', { task_id: 'task-1', status: 'done', completed_at: '2026-09-19T00:00:09Z' }]]),
    runtimeTasks: { 'task-1': runtime },
    agentOptions: AGENT_OPTIONS,
  });

  assert.deepEqual(rows.map((row) => row.role), ['user', 'agent']);
  assert.equal(rows[0].text, 'do it');
  assert.equal(rows[1].text, 'done');
  assert.equal(rows[1].agentName, 'General');
  assert.equal(rows[1].status, 'done');
  assert.equal(rows[1].traceHydrated, true);
  assert.deepEqual(
    rows[1].traceTimeline.map((item) => `${item.kind}:${item.label || item.text}`),
    ['text:Hello', 'tool:exec command'],
  );
  assert.deepEqual(rows[1].traceLatestTodos, [{ content: 'Ship it', status: 'in_progress', activeForm: '' }]);
  assert.equal(rows[1].firstTokenAt, Date.parse('2026-09-19T00:00:01Z'));
});

test('the phone timeline drops the thinking chip the user called old UI', () => {
  const runtime = runtimeTaskFromDetail(detail([
    rawEvent('e1', 'llm_thinking_delta', { delta: '先看仓库里有没有测试脚本' }),
    ...answerDeltas('Hello'),
    rawEvent('e3', 'tool_call_started', { call_id: 'c9', tool_name: 'exec_command', tool_input: { command: 'ls' } }),
  ]));
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm2', role: 'assistant', content: 'Hello', task_id: 'task-1' }],
    tasksById: new Map([['task-1', { task_id: 'task-1', status: 'done', completed_at: '2026-09-19T00:00:09Z' }]]),
    runtimeTasks: { 'task-1': runtime },
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows[0].traceTimeline.some((item) => item.kind === 'thinking'), false);
  assert.equal(runtime.eventLog.some((entry) => entry.type === 'llm_thinking_delta'), true);
});

// 持久化消息的正文就是答案本身，哪怕时间线上有同一段字（未定稿的那次会这样）也
// 不能去掉：done 行的时间线默认折着，去掉正文等于把答案藏起来。
test('a persisted answer keeps its body even when the timeline carries the same text', () => {
  const runtime = runtimeTaskFromDetail(detail([
    ...answerDeltas('Hello'),
    rawEvent('e3', 'tool_call_started', { call_id: 'c9', tool_name: 'exec_command', tool_input: { command: 'ls' } }),
    rawEvent('e4', 'llm_answer_delta', { delta: 'Hello' }),
  ]));
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm2', role: 'assistant', content: 'Hello', task_id: 'task-1' }],
    tasksById: new Map([['task-1', { task_id: 'task-1', status: 'done', completed_at: '2026-09-19T00:00:09Z' }]]),
    runtimeTasks: { 'task-1': runtime },
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows[0].text, 'Hello');
});

test('a row with only a summary says so instead of painting an empty timeline', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm2', role: 'assistant', content: 'done', task_id: 'task-1' }],
    tasksById: new Map([['task-1', { task_id: 'task-1', status: 'done', profile_display_name: 'General' }]]),
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows[0].traceHydrated, false);
  assert.deepEqual(rows[0].traceTimeline, []);
  assert.equal(rows[0].agentName, 'General');
  assert.equal(rows[0].firstTokenAt, 0);
});

// 缓存的执行记录会落后于会话摘要（任务刚落地的第一次轮询里，缓存还是 running
// 快照），已经收工的那一份说了算：跑完的任务不该还画成在跑。
test('a settled summary beats a runtime snapshot that still says running', () => {
  const running = runtimeTaskFromDetail(detail(answerDeltas('Hello')));
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm2', role: 'assistant', content: 'Hello', task_id: 'task-1' }],
    tasksById: new Map([['task-1', {
      task_id: 'task-1',
      status: 'done',
      completed_at: '2026-09-19T00:00:09Z',
    }]]),
    runtimeTasks: { 'task-1': running },
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows[0].status, 'done');
});

test('the live row streams on its own and stops rendering once the run lands', () => {
  const liveRun = runtimeTaskFromDetail(detail(answerDeltas('partial')));
  const base = {
    conversationId: 'convo-1',
    messages: [{ message_id: 'm1', role: 'user', content: 'go', task_id: 'task-1' }],
    optimisticMessages: [],
  };

  const streaming = buildChatRows({
    ...base,
    agentOptions: AGENT_OPTIONS,
    liveRun: { ...liveRun, status: 'running' },
    running: true,
  });
  assert.equal(streaming.length, 2);
  assert.equal(streaming[1].role, 'agent');
  assert.equal(streaming[1].streaming, true);
  // 流式正文由桌面 ChatMessageRow 自己从时间线画，行上的 text 留空。
  assert.equal(streaming[1].text, '');
  assert.equal(streaming[1].status, 'running');

  const settled = buildChatRows({
    ...base,
    agentOptions: AGENT_OPTIONS,
    liveRun: { ...liveRun, status: 'done' },
    running: false,
  });
  assert.equal(settled.length, 1);
});

test('an orphan reply row keeps the body when the trace says nothing about it', () => {
  const conversation = {
    messages: [{ message_id: 'm1', role: 'user', content: 'stop me', task_id: 'task-2' }],
    tasks: [{ task_id: 'task-2', status: 'cancelled', answer_text: 'I was writing', error: 'Cancelled by user.' }],
  };
  const replies = orphanTaskReplies(conversation);
  const rows = buildChatRows({
    conversationId: 'convo-1',
    conversation,
    messages: conversation.messages,
    tasksById: new Map([['task-2', conversation.tasks[0]]]),
    agentOptions: AGENT_OPTIONS,
    orphanReplyByAnchor: orphanReplyAnchors(conversation.messages, replies),
  });

  assert.deepEqual(rows.map((row) => row.id), ['m1', 'm1-reply']);
  assert.equal(rows[1].text, 'I was writing\n\nCancelled by user.');
  assert.equal(rows[1].status, 'cancelled');
  assert.equal(rows[1].traceHydrated, false);
});

// 取消的那次回答没定稿，过程文本留在时间线上，answer_text 又是同一段：正文不再重复。
test('a cancelled run whose trace already carries the partial answer does not repeat it', () => {
  const conversation = {
    messages: [{ message_id: 'm1', role: 'user', content: 'stop me', task_id: 'task-3' }],
    tasks: [{ task_id: 'task-3', status: 'cancelled', answer_text: '我先把这两条测试改成', error: 'Cancelled by user.' }],
  };
  const runtime = runtimeTaskFromDetail({
    task_id: 'task-3',
    status: 'cancelled',
    answer_text: '我先把这两条测试改成',
    error: 'Cancelled by user.',
    events: [
      rawEvent('e1', 'run_started'),
      rawEvent('e2', 'llm_answer_delta', { delta: '我先把这两条测试改成' }),
      // 被打断在那条命令上：过程文本因此成了时间线上的一个节点（只有 delta 时它算正文）。
      rawEvent('e3', 'tool_call_started', { call_id: 'c4', tool_name: 'exec_command', tool_input: { command: 'npm run build' } }),
    ],
  });
  const rows = buildChatRows({
    conversationId: 'convo-1',
    conversation,
    messages: conversation.messages,
    tasksById: new Map([['task-3', conversation.tasks[0]]]),
    runtimeTasks: { 'task-3': runtime },
    agentOptions: AGENT_OPTIONS,
    orphanReplyByAnchor: orphanReplyAnchors(conversation.messages, orphanTaskReplies(conversation)),
  });

  // 过程文本已经在时间线上（未定稿的那段），正文只剩错误说明。
  assert.equal(rows[1].text, 'Cancelled by user.');
  assert.deepEqual(
    rows[1].traceTimeline.map((item) => `${item.kind}:${item.text || item.label}`),
    ['text:我先把这两条测试改成', 'tool:exec command'],
  );
});

// 只有 delta 没有工具的那次打断：那段话算正文（桌面的时间线不管它），不重复。
test('a cancelled run that never reached a tool keeps its answer in the body', () => {
  const orphan = { task_id: 'task-5', status: 'cancelled', answer_text: 'half a sentence' };
  const runtime = runtimeTaskFromDetail({
    task_id: 'task-5',
    status: 'cancelled',
    answer_text: 'half a sentence',
    events: [
      rawEvent('e1', 'run_started'),
      rawEvent('e2', 'llm_answer_delta', { delta: 'half a sentence' }),
    ],
  });
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm1', role: 'user', content: 'stop me', task_id: 'task-5' }],
    tasksById: new Map([['task-5', orphan]]),
    runtimeTasks: { 'task-5': runtime },
    agentOptions: AGENT_OPTIONS,
    orphanReplyByAnchor: new Map([['m1', orphan]]),
  });

  assert.equal(rows[1].text, 'half a sentence');
  assert.deepEqual(rows[1].traceTimeline, []);
});

// 执行记录还没到手时（只有摘要）正文得自己磎上，不能因为时间线为空就丢掉。
test('a cancelled run without a trace still shows its partial answer', () => {
  const orphan = { task_id: 'task-4', status: 'cancelled', answer_text: 'half a sentence' };
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{ message_id: 'm1', role: 'user', content: 'stop me', task_id: 'task-4' }],
    tasksById: new Map([['task-4', orphan]]),
    agentOptions: AGENT_OPTIONS,
    orphanReplyByAnchor: new Map([['m1', orphan]]),
  });

  assert.equal(rows[1].text, 'half a sentence');
  assert.equal(rows[1].traceHydrated, false);
});

test('reply text never repeats the same body twice', () => {
  assert.equal(replyText({ answer_text: 'same' }, { answerText: 'same' }), 'same');
  assert.equal(replyText({ answer_text: '  ' }, {}), '');
  assert.equal(replyText({}, { answerText: 'body', error: 'boom' }), 'body\n\nboom');
});

test('optimistic user messages render as their own running rows', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [],
    optimisticMessages: [{ id: 'pending-1', text: 'hey', images: [{ path: '/tmp/a.png' }] }],
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].text, 'hey');
  assert.equal(rows[0].status, 'running');
  assert.deepEqual(rows[0].images, [{ path: '/tmp/a.png' }]);
  assert.equal(rows[0].taskId, '');
});

test('user rows carry the image refs of their message and task', () => {
  const rows = buildChatRows({
    conversationId: 'convo-1',
    messages: [{
      message_id: 'm1',
      role: 'user',
      content: 'look\n\n[user attached image #1: /tmp/a.png]\n\nThe user attached the image(s) above. Inspect the image files before answering; do not infer their contents from filenames.',
      task_id: 'task-1',
    }],
    tasksById: new Map([['task-1', { task_id: 'task-1', status: 'done', image_attachments: [{ path: '/tmp/a.png' }] }]]),
    agentOptions: AGENT_OPTIONS,
  });

  assert.equal(rows[0].text, 'look');
  // 消息正文里的标记先认，任务上的同一张图按 path 去重——一张图一个引用。
  assert.deepEqual(rows[0].images, [{
    image_id: 'restored-image-1-/tmp/a.png',
    path: '/tmp/a.png',
    mime: null,
  }]);
});

test('the draft shell is a running chat task with nothing in it yet', () => {
  const draft = draftRuntimeTask(1_700_000_000_000);

  assert.equal(draft.status, 'running');
  assert.equal(draft.executionMode, 'chat');
  assert.equal(draft.createdAt, 1_700_000_000_000);
  assert.deepEqual(draft.eventLog, []);
  assert.deepEqual(draft.toolCalls, []);
  assert.equal(draft.runtimeHydrated, true);
});
