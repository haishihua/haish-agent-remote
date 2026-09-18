// 手机端直接用桌面 chat 执行 UI 的数据接缝。
//
// 桌面的执行记录本身就是「事件数组」（runtime task 的 eventLog），
// `buildChatTimeline(task, status)` 是它的纯函数投影，行是 `ChatMessageRow`。
// 手机这边三条入口——详情/游标轮询（task-sync.js）、NDJSON 流（每条 token 一个
// 事件）、本地草稿（任务号还没回来）——都在这里折成**桌面形状**的 runtime task，
// 于是时间线、工具卡、todo、活动 orb 全部由桌面组件渲染，手机不再自己折一套
// segments（那套只服务手机手写的 TaskTrace，已删）。
//
// 折叠用的原语全部来自 pin 的桌面检出：normalizeRuntimeEvent → runtimeEventToLog →
// appendStreamEvent / compactStreamEvents（相邻 delta 合并成一条，流式时 timeline
// 还能走桌面的增量路径，见 chat-timeline.js 的 streamEventUpdate）。
import { appendStreamEvent, compactStreamEvents } from '../../haish-agent/app-web/src/features/chat/model/stream-events.js';
import { assistantNameForTask } from '../../haish-agent/app-web/src/features/chat/model/assistant-name.js';
import { buildChatTimeline } from '../../haish-agent/app-web/src/features/chat/model/chat-timeline.js';
import {
  getLoopIndexFromEvents,
  normalizeRuntimeEvent,
  runtimeEventToLog,
} from '../../haish-agent/app-web/src/features/tasks/model/runtime-events.js';
import { isTaskLive } from '../../haish-agent/app-web/src/features/conversations/model/conversation-status.js';
import {
  normalizeTaskStatus,
  taskFirstStreamTimestamp,
  taskSummaryToRuntimeTask,
} from '../../haish-agent/app-web/src/features/tasks/model/task-runtime.js';
import { chatMessageText, messageImageRefs } from './chat-images.js';

function timeMs(value) {
  if (!value) return 0;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function eventLoopIndex(rawEvent) {
  const value = Number(rawEvent?.loop_index ?? rawEvent?.loopIndex ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** 一条原始运行时事件 → 桌面 eventLog 条目。 */
export function runtimeLogEntry(rawEvent, task = null) {
  const event = normalizeRuntimeEvent(rawEvent);
  if (!event?.type) return null;
  const entry = runtimeEventToLog(event);
  return {
    ...entry,
    workflowNodeId: entry.workflowNodeId || task?.workflowRun?.current_node_id || null,
  };
}

/** 事件自带的身份：任务号在事件里先到，`api.startTask` 的 promise 才开始收尾。 */
export function runtimeEventIdentity(rawEvent) {
  const event = normalizeRuntimeEvent(rawEvent);
  return {
    taskId: String(event?.task_id || '') || null,
    conversationId: String(event?.conversation_id || '') || null,
  };
}

/**
 * NDJSON 流每来一条事件往上折一次。taskId / conversationId 从事件里补上
 * （任务号在事件里先到，`api.startTask` 的 promise 才结束）。
 */
export function runtimeTaskWithEvent(task, rawEvent) {
  if (!task) return task;
  const entry = runtimeLogEntry(rawEvent, task);
  if (!entry) return task;
  const identity = runtimeEventIdentity(rawEvent);
  return {
    ...task,
    taskId: task.taskId || identity.taskId,
    conversationId: task.conversationId || identity.conversationId,
    loopIndex: Math.max(Number(task.loopIndex || 0), eventLoopIndex(rawEvent)),
    eventLog: appendStreamEvent(task.eventLog || [], entry),
  };
}

// 摘要（会话详情里的 tasks[]）只带记录字段，折叠出来的日志留在上一次的原对象里。
function keepFoldedLog(summary, previous) {
  if (!previous) return summary;
  return {
    ...summary,
    eventLog: previous.eventLog || [],
    chatStreamText: previous.chatStreamText || '',
    toolCalls: previous.toolCalls || [],
    loopIndex: Math.max(Number(summary.loopIndex || 0), Number(previous.loopIndex || 0)),
    runtimeHydrated: previous.runtimeHydrated === true,
  };
}

/** 会话详情里的任务摘要 → runtime task（没有执行记录，只有记录字段）。 */
export function runtimeTaskFromSummary(task, previous = null) {
  if (!task?.task_id) return previous || null;
  return keepFoldedLog(taskSummaryToRuntimeTask(task, previous?.imageAttachments || []), previous);
}

/**
 * `GET /api/tasks/{id}` 的结果 → runtime task。带游标的那一问（`events_delta`）
 * 只回增量，所以是往已有的日志后面追加；整份重放（默认）直接替换。
 */
export function runtimeTaskFromDetail(task, previous = null) {
  if (!task?.task_id) return previous || null;
  const events = Array.isArray(task.events) ? task.events : [];
  const base = runtimeTaskFromSummary(task, previous);
  if (previous && task.events_delta === true) {
    let eventLog = previous.eventLog || [];
    for (const raw of events) {
      const entry = runtimeLogEntry(raw, previous);
      if (entry) eventLog = appendStreamEvent(eventLog, entry);
    }
    return {
      ...base,
      eventLog,
      loopIndex: Math.max(Number(base.loopIndex || 0), getLoopIndexFromEvents(events)),
      runtimeHydrated: true,
    };
  }
  const log = events.map((raw) => runtimeLogEntry(raw)).filter(Boolean);
  return {
    ...base,
    eventLog: compactStreamEvents(log),
    loopIndex: getLoopIndexFromEvents(events),
    runtimeHydrated: true,
  };
}

/** 本地草稿：任务号还没回来时的壳，事件照同一规则往上折。 */
export function draftRuntimeTask(now = Date.now()) {
  return {
    taskId: null,
    conversationId: null,
    title: '',
    description: '',
    status: 'running',
    stage: '',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    attachment: null,
    attachments: [],
    imageAttachments: [],
    loopIndex: 0,
    providerKey: 'auto',
    executionMode: 'chat',
    originViewMode: 'chat',
    userMessageId: null,
    annotations: [],
    displayText: null,
    inherited: false,
    assistantMessageId: null,
    answerText: '',
    chatStreamText: '',
    toolCalls: [],
    eventLog: [],
    error: null,
    serverFinished: false,
    runtimeHydrated: true,
  };
}

// 对话记录上是 snake_case（core 的 payload 原样），桌面的取名函数读 camelCase。
function conversationForNames(conversation) {
  if (!conversation) return null;
  return {
    agentId: conversation.agentId || conversation.agent_id || '',
    profileDisplayName: conversation.profileDisplayName || conversation.profile_display_name || '',
  };
}

function nameSourceFromSummary(summary) {
  if (!summary) return null;
  return {
    profileDisplayName: summary.profileDisplayName || summary.profile_display_name || '',
    profileId: summary.profileId || summary.profile_id || summary.agent_id || '',
    requestedAgentId: summary.agent_id || summary.profile_id || '',
  };
}

function userRow({ id, conversationId, taskId = '', content, images, createdAt = 0, status = 'done' }) {
  return {
    id,
    taskId,
    conversationId,
    role: 'user',
    text: chatMessageText(content),
    annotations: [],
    status,
    createdAt,
    completedAt: null,
    images: Array.isArray(images) ? images : [],
  };
}

// 缓存的执行记录可能落在会话摘要后面（任务刚落地时缓存里还是上一问的 running
// 快照），所以「已经收工的那一份」优先：跑完的任务不该还画成在跑。两边同档时以
// 执行记录为准——它是更细的那一份。
function resolveRowStatus(runtime, summary) {
  const runtimeStatus = runtime?.status ? normalizeTaskStatus(runtime.status) : '';
  const summaryStatus = summary?.status ? normalizeTaskStatus(summary.status) : '';
  if (!runtimeStatus) return summaryStatus || 'done';
  if (!summaryStatus) return runtimeStatus;
  const runtimeLive = isTaskLive(runtime);
  if (runtimeLive !== isTaskLive(summary)) return runtimeLive ? summaryStatus : runtimeStatus;
  return runtimeStatus;
}

// 时间线里已经有的那段话不再当正文重复一遍。取消/失败的任务最容易碰上：那次回答
// 还没定稿就被打断，过程文本（commentary）留在时间线上，answer_text 又是同一段。
function shownByTimeline(text, timelineItems) {
  const wanted = String(text || '').trim();
  if (!wanted) return false;
  return timelineItems.some(
    (item) => item.kind === 'text' && String(item.text || '').trim() === wanted,
  );
}

// 正文是一段段拼的（回答 + 错误说明），只去掉时间线上已经有的那几段。
function withoutTimelineDuplicates(text, timelineItems) {
  return String(text || '')
    .split('\n\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !shownByTimeline(part, timelineItems))
    .join('\n\n');
}

/**
 * 手机端不画一行：桌面的 thinking 折叠 chip（灯泡 + N chars）。
 *
 * 用户拍板：那个 chip 是老 UI 的观感，会话里不出现。折叠本身不动（事件日志、
 * 活动 orb 的文案都还是桌面那套），只是不把 thinking 节点交给行。
 */
function timelineItemsForPhone(timeline) {
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  return items.filter((item) => item.kind !== 'thinking');
}

function agentRow({
  id,
  conversationId,
  taskId,
  runtime = null,
  summary = null,
  agentName = '',
  text = '',
  messageId = null,
  streaming = false,
  createdAt = 0,
  completedAt = 0,
  // 只对「正文是拼出来的」那种行去重（取消/失败任务的本地回复）：持久化消息的正文
  // 就是答案本身，时间线上再出现一次也不能不要它（done 行的时间线默认是折着的，
  // 去掉正文等于把答案藏起来）。
  trimTimelineDuplicates = false,
}) {
  const status = resolveRowStatus(runtime, summary);
  // 只有折过执行记录的 runtime task 才有时间线；摘要只有记录字段，行上会说
  // 「Steps load when you scroll up.」，随后由可见性触发的加载补上。
  const hydrated = Boolean(runtime) && runtime.runtimeHydrated !== false;
  const timeline = hydrated ? buildChatTimeline(runtime, status) : null;
  const timelineItems = timelineItemsForPhone(timeline);
  return {
    id,
    taskId,
    conversationId,
    messageId: messageId || runtime?.assistantMessageId || summary?.assistant_message_id || null,
    role: 'agent',
    agentName: agentName || 'Assistant',
    text: streaming ? '' : (trimTimelineDuplicates ? withoutTimelineDuplicates(text, timelineItems) : text),
    progressLines: [],
    traceTimeline: timelineItems,
    traceHydrated: hydrated,
    traceLatestTodos: timeline?.latestTodos || null,
    status,
    streaming,
    createdAt: createdAt || runtime?.createdAt || timeMs(summary?.created_at),
    completedAt: completedAt || runtime?.completedAt || timeMs(summary?.completed_at),
    firstTokenAt: runtime ? taskFirstStreamTimestamp(runtime) || 0 : 0,
    annotations: [],
    images: [],
  };
}

// 取消/失败的任务在 runtime 侧没有落库的助手消息，本地回复的正文只存在于
// answer_text / error 里（桌面在这里显示 ErrorState，正文取 message.text）。
export function replyText(summary, runtime) {
  const parts = [String(runtime?.answerText || summary?.answer_text || ''), String(runtime?.error || summary?.error || '')]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  return parts.join('\n\n');
}

/**
 * 线程行。顺序就是消息顺序：持久化的消息行、没有落库回复的任务行（取消/失败）、
 * 发送中的乐观用户行、以及最后那条还在跑的实时行。
 */
export function buildChatRows({
  conversationId = '',
  conversation = null,
  messages = [],
  optimisticMessages = [],
  tasksById = null,
  runtimeTasks = null,
  liveRun = null,
  running = false,
  liveReplyPending = false,
  agentOptions = [],
  orphanReplyByAnchor = null,
} = {}) {
  const rows = [];
  const names = conversationForNames(conversation);
  const runtimeFor = (taskId) => (taskId && runtimeTasks ? runtimeTasks[taskId] || null : null);
  const summaryFor = (taskId) => (taskId && tasksById ? tasksById.get(taskId) || null : null);
  const agentNameFor = (runtime, summary) => assistantNameForTask(
    runtime || nameSourceFromSummary(summary) || {},
    names,
    agentOptions,
  );

  messages.forEach((item, index) => {
    const taskId = String(item?.task_id || '');
    const key = item?.message_id || item?.id || `message-${index}`;
    const summary = summaryFor(taskId);
    const runtime = runtimeFor(taskId);
    if (item?.role === 'user') {
      rows.push(userRow({
        id: key,
        conversationId,
        taskId,
        content: item?.content,
        images: messageImageRefs(item, summary),
        createdAt: timeMs(item?.created_at) || timeMs(summary?.created_at),
        status: normalizeTaskStatus(summary?.status || 'done'),
      }));
      // 取消/失败的任务没有落库的助手消息，回复挂在最后一条用户消息后面。
      const orphan = orphanReplyByAnchor?.get(key) || null;
      if (orphan?.task_id) {
        const orphanRuntime = runtimeFor(orphan.task_id);
        rows.push(agentRow({
          id: `${key}-reply`,
          conversationId,
          taskId: orphan.task_id,
          runtime: orphanRuntime,
          summary: orphan,
          agentName: agentNameFor(orphanRuntime, orphan),
          text: replyText(orphan, orphanRuntime),
          trimTimelineDuplicates: true,
          createdAt: timeMs(orphan.created_at),
          completedAt: timeMs(orphan.completed_at),
        }));
      }
      return;
    }
    rows.push(agentRow({
      id: `${key}-agent`,
      conversationId,
      taskId,
      runtime,
      summary,
      agentName: agentNameFor(runtime, summary),
      text: chatMessageText(item?.content),
      messageId: item?.message_id || item?.id || null,
      createdAt: timeMs(item?.created_at),
    }));
  });

  for (const item of optimisticMessages) {
    rows.push(userRow({
      id: item?.id || `pending-${rows.length}`,
      conversationId,
      taskId: '',
      content: item?.text,
      images: item?.images,
      createdAt: timeMs(item?.created_at) || Date.now(),
      status: 'running',
    }));
  }

  if (liveRun && (running || liveReplyPending)) {
    const liveTaskId = String(liveRun.taskId || '');
    rows.push(agentRow({
      id: `${liveTaskId || 'pending'}-live`,
      conversationId,
      taskId: liveTaskId,
      runtime: liveRun,
      summary: summaryFor(liveTaskId),
      agentName: agentNameFor(liveRun, summaryFor(liveTaskId)),
      streaming: Boolean(running),
    }));
  }
  return rows;
}
