import { chatMessageText } from './chat-images.js';

const SUCCESS = new Set(['done', 'completed']);
const FAILURE = new Set(['failed', 'error']);
const ACTIVE = new Set(['queued', 'running']);

export function taskNotificationStatus(task) {
  const status = String(task?.status || '').trim().toLowerCase();
  return SUCCESS.has(status) ? 'done' : FAILURE.has(status) ? 'failed' : null;
}

function completedTime(task) {
  const value = task?.completed_at || task?.completedAt;
  return typeof value === 'number' ? value : Date.parse(value || '') || 0;
}

/** Use the triggering user request, never the conversation name or assistant output. */
function taskNotificationRequest(task, conversation = {}) {
  const taskId = task?.task_id || task?.taskId;
  const userMessageId = task?.user_message_id || task?.userMessageId;
  const messages = (Array.isArray(conversation.messages) ? conversation.messages : [])
    .filter((message) => message?.role === 'user');
  const message = userMessageId
    ? messages.find((item) => (item.message_id || item.id) === userMessageId)
    : messages.find((item) => taskId && (item.task_id || item.taskId) === taskId);
  const display = task?.display_text ?? task?.displayText;
  const content = display ?? message?.content ?? task?.title;
  const text = chatMessageText(content)
    // Directory previews are bounded: don't expose a cut-off attachment marker/path.
    .replace(/\[user attached image #[^\]]*$/i, '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    body: text || 'Task request',
    priority: display != null ? 3 : message?.content != null ? 2 : task?.title ? 1 : 0,
  };
}

export function taskNotificationBody(task, conversation = {}) {
  return taskNotificationRequest(task, conversation).body;
}

/** Only durable task states count: a broken stream/request is not a failed task. */
export function createTaskNotificationTracker({ notify, now = () => Date.now() }) {
  const startedAt = now();
  const records = new Map();
  let active = true;

  function observe(task, conversation = {}) {
    if (!active) return;
    const taskId = String(task?.task_id || task?.taskId || '');
    const conversationId = String(task?.conversation_id || task?.conversationId || conversation.conversation_id || '');
    if (!taskId || !conversationId) return;
    const previous = records.get(taskId);
    const status = String(task?.status || '').trim().toLowerCase();
    const terminal = taskNotificationStatus(task);
    const record = previous || { eligible: false, settled: false, pending: false, body: 'Task request', bodyPriority: 0 };
    records.set(taskId, record);
    const request = taskNotificationRequest(task, conversation);
    if (request.priority >= record.bodyPriority && request.priority > 0) {
      record.body = request.body;
      record.bodyPriority = request.priority;
    }
    if (ACTIVE.has(status)) record.eligible = true;
    // First-seen historical terminal rows are a baseline, not notifications. A task that
    // starts AND finishes between polls is eligible only with a fresh completion timestamp.
    if (!previous && !terminal && !ACTIVE.has(status)) return;
    if (!previous && terminal) record.eligible = completedTime(task) >= startedAt;
    if (!terminal || !record.eligible || record.settled || record.pending) return;
    record.pending = true;
    Promise.resolve().then(() => active && notify({
      taskId,
      conversationId,
      status: terminal,
      title: terminal === 'done' ? 'Task completed' : 'Task failed',
      // Avoid raw errors, attachment paths, or assistant output on the lock screen.
      body: record.body,
    })).then(() => {
      record.settled = true;
    }).catch(() => {
      // Native scheduling errors are retried on the next authoritative snapshot, never
      // propagated into the task stream or reported as a task failure.
    }).finally(() => { record.pending = false; });
  }

  return { observe, dispose() { active = false; records.clear(); } };
}
