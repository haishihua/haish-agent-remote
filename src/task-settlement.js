export function persistedAssistantForTask(conversation, taskId) {
  const wanted = String(taskId || '');
  if (!wanted) return null;
  return (conversation?.messages || []).find((message) => (
    message?.role !== 'user' && String(message?.task_id || '') === wanted
  )) || null;
}

/**
 * The realtime response can close a fraction before the assistant message is visible from the
 * conversation endpoint. Poll that short persistence window so the live final answer can hand
 * off directly to the durable message instead of disappearing until the detail is reopened.
 */
export async function waitForPersistedAssistant({
  taskId,
  refresh,
  delays = [0, 120, 240, 480, 800, 1200],
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!taskId || typeof refresh !== 'function') return null;
  let latest = null;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    latest = await refresh();
    if (persistedAssistantForTask(latest, taskId)) return latest;
  }
  return latest;
}
