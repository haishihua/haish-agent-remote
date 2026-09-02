export function isTaskActuallyActive(task) {
  const status = String(task?.status || '').toLowerCase();
  if (status !== 'running' && status !== 'queued') return false;
  if (task?.completedAt || task?.completed_at) return false;
  return task?.serverFinished !== true && task?.server_finished !== true;
}

export function runningTaskForConversation(conversation, tasksById = {}) {
  const conversationTasks = Array.isArray(conversation?.tasks) ? conversation.tasks : [];
  const lastTask = tasksById[conversation?.last_task_id];
  const currentTasks = lastTask
    ? conversationTasks.map((task) => (task.task_id === lastTask.task_id ? lastTask : task))
    : conversationTasks;
  return [...currentTasks, ...(lastTask && !currentTasks.some((task) => task.task_id === lastTask.task_id) ? [lastTask] : [])]
    .reverse()
    .find(isTaskActuallyActive) || null;
}

export function listTaskForConversation(conversation, tasksById = {}) {
  return runningTaskForConversation(conversation, tasksById)
    || tasksById[conversation?.last_task_id]
    || null;
}

export function runningConversationsFirst(conversations, tasksById = {}) {
  return (Array.isArray(conversations) ? conversations : [])
    .map((conversation, index) => ({
      conversation,
      index,
      active: Boolean(runningTaskForConversation(conversation, tasksById)),
    }))
    .sort((left, right) => {
      const activeDifference = Number(right.active) - Number(left.active);
      if (activeDifference) return activeDifference;
      const orderDifference = (left.conversation.sort_order ?? 0) - (right.conversation.sort_order ?? 0);
      return orderDifference || left.index - right.index;
    })
    .map(({ conversation }) => conversation);
}
