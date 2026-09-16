// Conversation ordering for the phone mirrors the desktop sidebar
// (`app-web/src/features/conversations/model/workspace-state.js`):
//   pinned first, then a conversation with a running/queued task, then by real
//   activity (when the newest task started, or when it settled), then by the
//   stored sort order.
// The timestamps deliberately avoid a running task's `updated_at`: the runtime
// rewrites it on every streamed chunk, which used to reshuffle the list while
// two conversations ran at once.

export const CONVERSATION_PREVIEW_LIMIT = 3;

const SETTLED_TASK_STATUSES = new Set(['done', 'completed', 'failed', 'cancelled', 'aborted']);

export function isTaskActuallyActive(task) {
  const status = String(task?.status || '').toLowerCase();
  if (status !== 'running' && status !== 'queued') return false;
  if (task?.completedAt || task?.completed_at) return false;
  return task?.serverFinished !== true && task?.server_finished !== true;
}

export function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function taskUpdatedTimestamp(task) {
  if (!task) return 0;
  return Math.max(
    timestampValue(task.updated_at),
    timestampValue(task.updatedAt),
    timestampValue(task.completed_at),
    timestampValue(task.completedAt),
    timestampValue(task.created_at),
    timestampValue(task.createdAt),
  );
}

function taskCreatedTimestamp(task) {
  if (!task) return 0;
  return Math.max(timestampValue(task.created_at), timestampValue(task.createdAt));
}

export function isSettledTask(task) {
  if (!task) return true;
  if (task.completed_at || task.completedAt) return true;
  if (task.server_finished === true || task.serverFinished === true) return true;
  return SETTLED_TASK_STATUSES.has(String(task.status || '').toLowerCase());
}

// A task that has not settled yet has its `updated_at` rewritten by every
// streamed chunk, so its start time is the stable anchor; a settled task ranks
// by when it settled.
export function taskOrderTimestamp(task) {
  return isSettledTask(task) ? taskUpdatedTimestamp(task) : taskCreatedTimestamp(task);
}

// The directory listing carries the newest task plus any active one, while the
// polled task map may hold a fresher copy of the same task; prefer the map.
export function conversationTasks(conversation, tasksById = {}) {
  const embedded = Array.isArray(conversation?.tasks) ? conversation.tasks : [];
  const tasks = embedded
    .map((task) => (task?.task_id && tasksById[task.task_id]) || task)
    .filter(Boolean);
  const lastTask = tasksById[conversation?.last_task_id];
  if (lastTask && !tasks.some((task) => task.task_id === lastTask.task_id)) tasks.push(lastTask);
  return tasks;
}

export function conversationHasActiveTask(conversation, tasksById = {}) {
  return conversationTasks(conversation, tasksById).some(isTaskActuallyActive);
}

export function conversationOrderTimestamp(conversation, tasksById = {}) {
  const tasks = conversationTasks(conversation, tasksById);
  if (!tasks.length) {
    // The desktop client also folds in a locally dragged order (`manualOrderAt`);
    // the directory API does not expose it, so the phone ranks on the timestamp.
    return Math.max(timestampValue(conversation?.updated_at), timestampValue(conversation?.updatedAt));
  }
  return tasks.reduce((latest, task) => Math.max(latest, taskOrderTimestamp(task)), 0);
}

export function orderConversations(conversations, tasksById = {}) {
  return (Array.isArray(conversations) ? conversations : [])
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      const a = left.conversation;
      const b = right.conversation;
      const pinnedDifference = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
      if (pinnedDifference) return pinnedDifference;
      const activeDifference = Number(conversationHasActiveTask(b, tasksById))
        - Number(conversationHasActiveTask(a, tasksById));
      if (activeDifference) return activeDifference;
      return conversationOrderTimestamp(b, tasksById) - conversationOrderTimestamp(a, tasksById)
        || (a?.sort_order ?? 0) - (b?.sort_order ?? 0)
        || left.index - right.index;
    })
    .map(({ conversation }) => conversation);
}

// Projects: pinned first, then the stored sort order (the desktop rule).
export function orderProjects(projects) {
  return (Array.isArray(projects) ? projects : [])
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      const pinnedDifference = Number(Boolean(right.project?.pinned)) - Number(Boolean(left.project?.pinned));
      if (pinnedDifference) return pinnedDifference;
      return (left.project?.sort_order ?? 0) - (right.project?.sort_order ?? 0) || left.index - right.index;
    })
    .map(({ project }) => project);
}

export function runningTaskForConversation(conversation, tasksById = {}) {
  return [...conversationTasks(conversation, tasksById)].reverse().find(isTaskActuallyActive) || null;
}

export function listTaskForConversation(conversation, tasksById = {}) {
  return runningTaskForConversation(conversation, tasksById)
    || tasksById[conversation?.last_task_id]
    || null;
}
