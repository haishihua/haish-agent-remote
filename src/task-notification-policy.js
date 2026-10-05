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
    const record = previous || { eligible: false, settled: false, pending: false };
    records.set(taskId, record);
    if (ACTIVE.has(status)) record.eligible = true;
    // First-seen historical terminal rows are a baseline, not notifications. A task that
    // starts AND finishes between polls is eligible only with a fresh completion timestamp.
    if (!previous && !terminal && !ACTIVE.has(status)) return;
    if (!previous && terminal) record.eligible = completedTime(task) >= startedAt;
    if (!terminal || !record.eligible || record.settled || record.pending) return;
    record.pending = true;
    const title = String(conversation.title || conversation.label || task.title || 'Haish task').trim().slice(0, 160);
    Promise.resolve().then(() => active && notify({
      taskId,
      conversationId,
      status: terminal,
      title: terminal === 'done' ? '任务完成' : '任务失败',
      // Avoid putting raw errors, credentials, or assistant output on the lock screen.
      body: title || 'Haish task',
    })).then(() => {
      record.settled = true;
    }).catch(() => {
      // Native scheduling errors are retried on the next authoritative snapshot, never
      // propagated into the task stream or reported as a task failure.
    }).finally(() => { record.pending = false; });
  }

  return { observe, dispose() { active = false; records.clear(); } };
}
