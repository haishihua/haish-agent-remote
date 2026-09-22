// 会话列表行右端那个状态坑位：判据与桌面侧栏同一份 —— 「放什么」由桌面的
// app-web/src/features/conversations/model/conversation-run-state.js 决定，「终态串」由
// app-web/src/features/tasks/model/task-completion-notices.js 归一化，这里不另列一份状态串。
//
//   1. 在等人（未回答提问 / 未决审批）—— 琥珀字形；
//   2. 在跑 —— 蓝圈；
//   3. 跑完但你还没看过 —— 终态点（done 绿 / failed 红 / cancelled 金）；
//   4. 都不是 —— 熄灯。
//
// 「还没看过」两头记的东西不同：桌面把「跑完而你没在看」记成一条 notice（它的进程一直开着，任务落地
// 那一刻它就在旁边）；手机不一定开着，所以记的是「最后一次离开这个会话的时刻」（seenAt）。判据是同一
// 件事：最新一轮任务落地的时刻比它新就亮灯。打开会话（进详情）与离开会话都把时刻推到当下，灯跟着灭
// ——与桌面「看过就熄灯」的那条规矩一致。手机上第一次见到的会话以那一刻为基线，装上手机之前跑完的
// 任务不补灯。
import { terminalTaskNoticeStatus } from '../../haish-agent/app-web/src/features/tasks/model/task-completion-notices.js';
import {
  resolveConversationRunState,
  resolveConversationStatusMark,
} from '../../haish-agent/app-web/src/features/conversations/model/conversation-run-state.js';
import {
  conversationTasks,
  timestampValue,
} from './conversation-order.js';

// 与手机上的会话 id 绑在一起看：这份时刻表只对这台手机有意义（桌面自己有一份 notices）。
export const CONVERSATION_SEEN_STORAGE_KEY = 'haish.conversation-seen-at.v1';

/** 一轮任务落地（done / failed / cancelled）的时刻；`completed_at` 优先，没有才退到 `updated_at`。 */
export function taskSettledAt(task) {
  return timestampValue(task?.completed_at)
    || timestampValue(task?.completedAt)
    || timestampValue(task?.updated_at)
    || timestampValue(task?.updatedAt);
};

/** 最新的一轮 = 开始得最晚的那个任务（目录里一个会话只带最新一轮 + 还在跑的那几轮）。 */
function latestTask(tasks) {
  let latest = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    const at = timestampValue(task?.created_at)
      || timestampValue(task?.createdAt)
      || timestampValue(task?.updated_at)
      || timestampValue(task?.updatedAt);
    if (at >= latestAt) {
      latestAt = at;
      latest = task;
    }
  }
  return latest;
}

/**
 * 这个会话最新一轮任务落地了没：落地了返回 `{ status, settledAt, taskId }`，没落地（还在跑 / 没有
 * 任务）返回 null。任务还在跑时这里不返回终态——同一个坑位里「现在」压过「过去」，判据是桌面那份
 * `resolveConversationStatusMark`。
 */
export function conversationTerminalNotice(conversation, tasksById = {}) {
  const task = latestTask(conversationTasks(conversation, tasksById));
  const status = terminalTaskNoticeStatus(task);
  if (!status) return null;
  return {
    status,
    settledAt: taskSettledAt(task),
    taskId: String(task?.task_id || task?.taskId || ''),
  };
}

/**
 * 行尾坑位里放什么：
 *   - `null` → 熄灯；
 *   - `{ kind: 'running' | 'waiting_input' | 'approval', status: '' }` → 在跑 / 在等人；
 *   - `{ kind: 'terminal', status: 'done' | 'failed' | 'cancelled' }` → 跑完了，你还没看过。
 */
export function conversationStatusSlot({
  conversation,
  tasksById = {},
  seenAt = {},
  pendingInputs = [],
  pendingApprovals = [],
} = {}) {
  const conversationId = String(conversation?.conversation_id || '');
  if (!conversationId) return null;
  const runState = resolveConversationRunState({
    conversationId,
    tasks: conversationTasks(conversation, tasksById),
    pendingInputs,
    pendingApprovals,
  });
  const notice = conversationTerminalNotice(conversation, tasksById);
  const seen = Number(seenAt[conversationId] || 0);
  return resolveConversationStatusMark({
    runState: runState.state,
    terminalStatus: notice && notice.settledAt > seen ? notice.status : '',
  });
}

export function loadConversationSeenAt(storage) {
  if (!storage) return {};
  try {
    const value = JSON.parse(storage.getItem(CONVERSATION_SEEN_STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const seen = {};
    for (const [conversationId, at] of Object.entries(value)) {
      const ms = Number(at);
      if (conversationId && Number.isFinite(ms) && ms > 0) seen[conversationId] = ms;
    }
    return seen;
  } catch {
    // 坏掉的记录只当没记过：那一份基线回到「现在」，最多多亮一次灯，不会瞎亮。
    return {};
  }
}

export function saveConversationSeenAt(storage, seenAt) {
  if (!storage) return;
  try {
    storage.setItem(CONVERSATION_SEEN_STORAGE_KEY, JSON.stringify(seenAt || {}));
  } catch {
    // 存不下就只在内存里活着（这份时刻表只影响行尾那个点，不值得打断任何操作）。
  }
}

/**
 * 第一次在手机上见到的会话以 `now` 为基线（返回新对象；一个都没新增时返回原来那份，调用方据此跳过
 * 写入与重渲染）。
 */
export function seedConversationSeenAt(seenAt, conversationIds, now) {
  let next = seenAt && typeof seenAt === 'object' ? seenAt : null;
  for (const conversationId of Array.isArray(conversationIds) ? conversationIds : []) {
    const id = String(conversationId || '');
    if (!id || next?.[id]) continue;
    if (!next) next = {};
    else if (next === seenAt) next = { ...seenAt };
    next[id] = now;
  }
  return next || {};
}

/** 看过 / 刚离开这个会话：时刻推到当下，行尾的终态点跟着灭。 */
export function markConversationSeen(seenAt, conversationId, now) {
  const id = String(conversationId || '');
  if (!id) return seenAt;
  return mergeConversationSeenAt(seenAt, { [id]: now });
}

/** Merge the adapter's canonical cursors without letting a stale poll move any cursor backwards. */
export function mergeConversationSeenAt(seenAt, incoming) {
  const current = seenAt && typeof seenAt === 'object' ? seenAt : {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return current;
  let next = current;
  for (const [conversationId, value] of Object.entries(incoming)) {
    const at = Number(value);
    if (!conversationId || !Number.isFinite(at) || at <= Number(current[conversationId] || 0)) continue;
    if (next === current) next = { ...current };
    next[conversationId] = at;
  }
  return next;
}
