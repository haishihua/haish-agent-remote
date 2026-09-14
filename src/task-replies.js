// Cancelled and failed tasks never receive a persisted assistant message on the
// runtime side, so the phone would render a user message with no reply at all.
// These helpers find those tasks and the user message each local reply belongs
// to, so the thread can show the trace and the partial answer that do exist.

const REPLYLESS_STATUSES = new Set(['cancelled', 'failed']);

export function taskHasNoAssistantMessage(task) {
  return !task?.assistant_message_id;
}

export function isReplylessTask(task) {
  return taskHasNoAssistantMessage(task) && REPLYLESS_STATUSES.has(String(task?.status || '').toLowerCase());
}

export function orphanTaskReplies(conversation) {
  const replies = new Map();
  const answered = new Set(
    (conversation?.messages || [])
      .filter((item) => item?.role !== 'user' && item?.task_id)
      .map((item) => item.task_id),
  );
  for (const task of conversation?.tasks || []) {
    if (!task?.task_id || answered.has(task.task_id) || !isReplylessTask(task)) continue;
    replies.set(task.task_id, task);
  }
  return replies;
}

function messageKey(item, index) {
  return item?.message_id || item?.id || `message-${index}`;
}

// The reply belongs to the last user message of its task: steering sends several
// user messages for one task, and only the final one should carry the trace.
export function orphanReplyAnchors(messages, replies) {
  const anchors = new Map();
  if (!replies?.size) return anchors;
  (messages || []).forEach((item, index) => {
    if (item?.role !== 'user' || !replies.has(item.task_id)) return;
    for (const [key, task] of anchors) {
      if (task.task_id === item.task_id) anchors.delete(key);
    }
    anchors.set(messageKey(item, index), replies.get(item.task_id));
  });
  return anchors;
}
