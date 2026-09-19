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
import { chatMessageText, messageImageRefs, userMessageText } from './chat-images.js';

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

function userRow({
  id,
  conversationId,
  taskId = '',
  messageId = null,
  text = '',
  images,
  annotations = [],
  createdAt = 0,
  status = 'done',
}) {
  return {
    id,
    taskId,
    conversationId,
    // 桌面的行用 messageId 认「这一条已经落到服务端」：引用批注的草稿就是按这个把位置让给
    // 服务端快照的（见 desktop 的 model/message-annotations.js）。**乐观行必须是 null**：那
    // 时候这一条还没落库，草稿得留着当恢复副本（发失败时就是它回到输入框），只有服务端快照
    // 才算认领。
    messageId: messageId || null,
    role: 'user',
    text,
    annotations: Array.isArray(annotations) ? annotations : [],
    status,
    createdAt,
    completedAt: null,
    images: Array.isArray(images) ? images : [],
  };
}

/**
 * 一条任务上的引用批注只属于它的**第一条**用户消息。
 *
 * annotations 只随 `task.start` 提交（steering 的 inputs 不接受它），所以一条任务里
 * 后面那几条 steering 消息不背注释；runtime 在任务记录上记的 `user_message_id` 说的
 * 就是那一条（见 core 的 app/annotations.py 与 _validate_message_annotations）。
 * 老快照没有那个字段时退回到「这条任务里最早的用户消息」。
 */
function rowAnnotations(summary, messageId, firstUserMessageId) {
  const items = Array.isArray(summary?.annotations) ? summary.annotations : [];
  if (!items.length) return [];
  const owner = String(summary?.user_message_id || firstUserMessageId || '');
  return owner && owner === String(messageId || '') ? items : [];
}

/** 任务号 → 该任务的第一条用户消息（`rowAnnotations` 的兜底用）。 */
function firstUserMessageIds(messages) {
  const owners = new Map();
  for (const item of messages || []) {
    const taskId = String(item?.task_id || '');
    if (item?.role !== 'user' || !taskId || owners.has(taskId)) continue;
    owners.set(taskId, item?.message_id || item?.id || '');
  }
  return owners;
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

// 没有时间线（只有任务摘要、还没折过执行记录）的行共用这一份：行对象要按**引用**比
// （chat-view.jsx 的 sameRow / stabilizeRows），每次新建一个 `[]` 会让那一行每帧换
// 身份、整行重画。冻结是提醒：这份数组只读。
const NO_TIMELINE_ITEMS = Object.freeze([]);
// 过滤过的时间线按桌面那份 `items` 数组记忆。桌面的 buildChatTimeline 对同一个 runtime
// task 回的本来就是缓存里的同一个时间线（items 身份稳），所以这一层也稳得住。
const PHONE_TIMELINE_ITEMS = new WeakMap();

/**
 * 手机端不画一行：桌面的 thinking 折叠 chip（灯泡 + N chars）。
 *
 * 用户拍板：那个 chip 是老 UI 的观感，会话里不出现。折叠本身不动（事件日志、
 * 活动 orb 的文案都还是桌面那套），只是不把 thinking 节点交给行。
 *
 * 但**身份必须稳**：没有 thinking 时直接回桌面那份 items（一个都不复制），有的按
 * items 记忆一份。fc797d7 起这里是每次 `filter` 出新数组，于是
 * `previous.traceTimeline !== next.traceTimeline` 永远成立——一条流事件就把整条线程
 * 的每一行（Markdown 正文、工具卡、todo）全部重画一遍。行这段 memo 和工具卡的展开态
 * 都挂在这份身份上（回归用例见 tests/chat-runtime.test.mjs 的「行身份」两条）。
 */
function timelineItemsForPhone(timeline) {
  const items = Array.isArray(timeline?.items) ? timeline.items : null;
  if (!items || items.length === 0) return NO_TIMELINE_ITEMS;
  const memoized = PHONE_TIMELINE_ITEMS.get(items);
  if (memoized) return memoized;
  const filtered = items.some((item) => item?.kind === 'thinking')
    ? items.filter((item) => item.kind !== 'thinking')
    : items;
  PHONE_TIMELINE_ITEMS.set(items, filtered);
  return filtered;
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

  // 任务的第一条用户消息（`rowAnnotations` 的兜底，见那里的注释）。
  const firstUserByTask = firstUserMessageIds(messages);
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
        messageId: item?.message_id || item?.id || null,
        // 正文不等于「这一条说的是什么」：注解轮的正文里带着拼给模型看的引用块
        // （见 chat-images.js 的 userMessageText）。
        text: userMessageText(item, summary),
        images: messageImageRefs(item, summary),
        annotations: rowAnnotations(summary, item?.message_id || item?.id, firstUserByTask.get(taskId)),
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
      // 行上那条「用时」（桌面 ChatMessageRow 的 elapsed：折叠条上的 `3m 47s`，跑的时候
      // 是名字旁边一直跳的那个）算的是**任务的窗口**：桌面 AppShell 的行取 `task.createdAt`
      // → `task.completedAt`。助手消息自己的 `created_at` 是它**落库**的那一刻——离收工
      // 不到一秒，拿它当起点，行上那条时长就永远是 `0s`（手机上一直是这么显示的，桌面
      // 同一行是真实时长）。消息时间只在任务摘要缺失时兜底，别让行没有时间。
      createdAt: timeMs(summary?.created_at) || timeMs(item?.created_at),
    }));
  });

  for (const item of optimisticMessages) {
    rows.push(userRow({
      id: item?.id || `pending-${rows.length}`,
      conversationId,
      taskId: '',
      // 乐观行还没拿到服务端 message_id：引用批注的草稿靠这个保持在输入框里，
      // 直到服务端快照把同一批注释带回来（见 model/message-annotations.js）。
      messageId: null,
      text: chatMessageText(item?.text),
      images: item?.images,
      annotations: item?.annotations || [],
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
      text: running ? '' : replyText(summaryFor(liveTaskId), liveRun),
      streaming: Boolean(running),
      completedAt: running ? 0 : liveRun.completedAt,
    }));
  }
  return rows;
}
