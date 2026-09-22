import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_SEEN_STORAGE_KEY,
  conversationStatusSlot,
  conversationTerminalNotice,
  loadConversationSeenAt,
  markConversationSeen,
  mergeConversationSeenAt,
  saveConversationSeenAt,
  seedConversationSeenAt,
  taskSettledAt,
} from '../src/conversation-status.js';

const DONE_AT = Date.parse('2026-09-18T20:02:47Z');
const SEEN_BEFORE = DONE_AT - 60_000;
const SEEN_AFTER = DONE_AT + 60_000;

function fakeStorage(initial) {
  const entries = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
    entries,
  };
}

const runningTask = {
  task_id: 'task-run',
  status: 'running',
  created_at: '2026-09-18T19:54:00Z',
  updated_at: '2026-09-18T19:55:00Z',
};

const doneTask = {
  task_id: 'task-done',
  status: 'done',
  created_at: '2026-09-18T19:54:00Z',
  updated_at: '2026-09-18T20:03:00Z',
  completed_at: '2026-09-18T20:02:47Z',
};

function conversation(overrides = {}) {
  return {
    conversation_id: 'c',
    last_task_id: doneTask.task_id,
    tasks: [doneTask],
    ...overrides,
  };
}

test('a settled task ranks by when it landed, falling back to updated_at', () => {
  assert.equal(taskSettledAt(doneTask), DONE_AT);
  assert.equal(taskSettledAt({ status: 'failed', updated_at: '2026-09-18T20:00:00Z' }), Date.parse('2026-09-18T20:00:00Z'));
  assert.equal(taskSettledAt({ status: 'done' }), 0);
  assert.equal(taskSettledAt(null), 0);
});

test('the terminal notice normalizes the status and carries the landing time', () => {
  assert.deepEqual(conversationTerminalNotice(conversation()), { status: 'done', settledAt: DONE_AT, taskId: 'task-done' });
  assert.equal(
    conversationTerminalNotice({ conversation_id: 'c', last_task_id: doneTask.task_id, tasks: [] }, { [doneTask.task_id]: doneTask })?.status,
    'done',
    '目录里那份只在 tasksById（列表的 task 表）里的 last task 也要算',
  );
  assert.deepEqual(
    conversationTerminalNotice({ conversation_id: 'c', tasks: [{ task_id: 't', status: 'canceled', updated_at: '2026-09-18T20:00:00Z' }] }),
    { status: 'cancelled', settledAt: Date.parse('2026-09-18T20:00:00Z'), taskId: 't' },
  );
  assert.equal(conversationTerminalNotice({ conversation_id: 'c', tasks: [runningTask] }), null, '还在跑就没有终态');
  assert.equal(conversationTerminalNotice({ conversation_id: 'c', tasks: [] }), null);
  assert.equal(conversationTerminalNotice(), null);
});

test('a running task keeps the blue slot — “现在”压过“过去”', () => {
  const slot = conversationStatusSlot({
    conversation: { conversation_id: 'c', tasks: [doneTask, runningTask] },
    seenAt: { c: SEEN_BEFORE },
  });
  assert.deepEqual(slot, { kind: 'running', status: '' });
});

test('a task that landed after the last look turns the row into a green dot', () => {
  const unseen = conversationStatusSlot({ conversation: conversation(), seenAt: { c: SEEN_BEFORE } });
  assert.deepEqual(unseen, { kind: 'terminal', status: 'done' });
  const seen = conversationStatusSlot({ conversation: conversation(), seenAt: { c: SEEN_AFTER } });
  assert.equal(seen, null, '看过之后熄灯');
  const neverSeen = conversationStatusSlot({ conversation: conversation(), seenAt: {} });
  assert.deepEqual(neverSeen, { kind: 'terminal', status: 'done' });
  // 没有基线时按 0 算：那是“从来没记过”，宁可亮一次也绝不吞掉一次完成。
  // 手机上真跑不到这个分支：目录一回来就先 seed 再渲染（同一次 state 更新）。
});

test('failed and cancelled rows get their own terminal dot', () => {
  assert.deepEqual(
    conversationStatusSlot({ conversation: { conversation_id: 'c', tasks: [{ task_id: 't', status: 'error', updated_at: '2026-09-18T20:04:00Z' }] }, seenAt: { c: SEEN_BEFORE } }),
    { kind: 'terminal', status: 'failed' },
  );
  assert.deepEqual(
    conversationStatusSlot({ conversation: { conversation_id: 'c', tasks: [{ task_id: 't', status: 'cancelled', updated_at: '2026-09-18T20:04:00Z' }] }, seenAt: { c: SEEN_BEFORE } }),
    { kind: 'terminal', status: 'cancelled' },
  );
});

test('waiting for the user lights the amber slot, and outranks both running and terminal', () => {
  const base = {
    conversation: { conversation_id: 'c', tasks: [doneTask, runningTask] },
    seenAt: { c: SEEN_BEFORE },
  };
  assert.deepEqual(
    conversationStatusSlot({ ...base, pendingInputs: [{ request_id: 'r', conversation_id: 'c', task_id: 'task-run' }] }),
    { kind: 'waiting_input', status: '' },
  );
  assert.deepEqual(
    conversationStatusSlot({ ...base, pendingApprovals: [{ request_id: 'r', conversation_id: 'c', task_id: 'task-run' }] }),
    { kind: 'approval', status: '' },
  );
  assert.deepEqual(
    // 快照指的那个任务手机这边还没有：仍然信快照（桌面的 resolveConversationWaitState 同样处理）。
    conversationStatusSlot({ ...base, conversation: conversation(), pendingInputs: [{ request_id: 'r', conversation_id: 'c', task_id: 'unknown' }] }),
    { kind: 'waiting_input', status: '' },
  );
  assert.deepEqual(
    conversationStatusSlot({ ...base, conversation: { conversation_id: 'c', tasks: [doneTask] }, pendingInputs: [{ request_id: 'r', conversation_id: 'other', task_id: 'task-run' }] }),
    { kind: 'terminal', status: 'done' },
    '别的会话的提问不亮这一行，它照自己的终态点亮',
  );
});

test('the seen-at table seeds new conversations at “now” and leaves known ones alone', () => {
  const seenAt = { c1: SEEN_BEFORE };
  const seeded = seedConversationSeenAt(seenAt, ['c1', 'c2', 'c2', ''], SEEN_AFTER);
  assert.deepEqual(seeded, { c1: SEEN_BEFORE, c2: SEEN_AFTER });
  assert.equal(seedConversationSeenAt(seenAt, ['c1'], SEEN_AFTER), seenAt, '一个都没新增时原样返回');
  assert.equal(seedConversationSeenAt(seenAt, null, SEEN_AFTER), seenAt);
  assert.equal(seedConversationSeenAt(undefined, ['c1'], SEEN_AFTER).c1, SEEN_AFTER);
});

test('shared read cursors merge monotonically across desktop and remote clients', () => {
  const seenAt = { c1: SEEN_AFTER, c2: SEEN_BEFORE };
  const merged = mergeConversationSeenAt(seenAt, {
    c1: SEEN_BEFORE,
    c2: SEEN_AFTER,
    c3: DONE_AT,
    bad: 'not-a-time',
  });
  assert.deepEqual(merged, { c1: SEEN_AFTER, c2: SEEN_AFTER, c3: DONE_AT });
  assert.equal(mergeConversationSeenAt(merged, { c1: SEEN_BEFORE }), merged);
  assert.equal(mergeConversationSeenAt(merged, null), merged);
});

test('marking a conversation seen moves its stamp, and the table survives a reload', () => {
  const storage = fakeStorage();
  const seenAt = markConversationSeen({ c1: SEEN_BEFORE }, 'c1', SEEN_AFTER);
  assert.deepEqual(seenAt, { c1: SEEN_AFTER });
  assert.equal(markConversationSeen(seenAt, '', SEEN_AFTER), seenAt);
  saveConversationSeenAt(storage, seenAt);
  assert.ok(storage.entries.has(CONVERSATION_SEEN_STORAGE_KEY));
  assert.deepEqual(loadConversationSeenAt(storage), { c1: SEEN_AFTER });
  // 行尾那个点不该被一次读写弄丢，也不该被坏数据炸掉。
  assert.deepEqual(loadConversationSeenAt(fakeStorage({ [CONVERSATION_SEEN_STORAGE_KEY]: 'not json' })), {});
  assert.deepEqual(loadConversationSeenAt(fakeStorage({ [CONVERSATION_SEEN_STORAGE_KEY]: '[]' })), {});
  assert.deepEqual(loadConversationSeenAt(fakeStorage({ [CONVERSATION_SEEN_STORAGE_KEY]: '{"c1": null, "c2": 5}' })), { c2: 5 });
  assert.deepEqual(loadConversationSeenAt(), {});
  saveConversationSeenAt(null, seenAt);
});
