import { api } from './api.js';
import { applyTaskRecord, applyTaskStreamEvent, initialTaskStreamState } from './task-stream.js';

// Cursor-based runtime task reads. The runtime exposes `after_event_id` plus an
// `events_delta` flag (the desktop client already reads tasks that way); this
// module keeps the phone on the same protocol instead of re-downloading the
// whole event log every two seconds.
//
// The phone also has no place to keep what it has already folded, so a poll
// used to rebuild the whole trace from scratch. The cache below holds the fold
// (and its cursor) while the record fields are overlaid on read.
const TASK_CACHE_LIMIT = 8;
const DEFAULT_RETRY_MS = 2_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

function taskRecordFields(task) {
  return {
    task_id: task?.task_id,
    status: task?.status,
    answer_text: task?.answer_text,
    error: task?.error,
    created_at: task?.created_at,
    completed_at: task?.completed_at,
  };
}

function sameRecordFields(left, right) {
  return Boolean(left && right)
    && left.status === right.status
    && left.answer_text === right.answer_text
    && left.error === right.error
    && left.completed_at === right.completed_at;
}

export function createTaskRuntimeCache({ limit = TASK_CACHE_LIMIT } = {}) {
  const entries = new Map();

  function evict() {
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      entries.delete(oldest);
    }
  }

  return {
    cursor(taskId) {
      return entries.get(String(taskId || ''))?.lastEventId || null;
    },
    state(taskId) {
      return entries.get(String(taskId || ''))?.snapshot || null;
    },
    // Appends the payload to the cached fold only when the runtime confirmed
    // our cursor (`events_delta: true`); every other answer is a full replay
    // that replaces the entry.
    remember(task) {
      const taskId = String(task?.task_id || '');
      if (!taskId) return null;
      const previous = entries.get(taskId) || null;
      const events = Array.isArray(task?.events) ? task.events : [];
      const append = Boolean(previous) && task?.events_delta === true;
      const record = taskRecordFields(task);
      if (append && !events.length && sameRecordFields(previous.record, record)) {
        // Idle poll: hand back the same object so React can skip the repaint.
        return previous.snapshot;
      }
      let state = append ? previous.state : initialTaskStreamState(task);
      for (const event of events) state = applyTaskStreamEvent(state, event);
      const lastEventId = events.length
        ? String(events[events.length - 1]?.event_id || '') || (append ? previous.lastEventId : null)
        : (append ? previous.lastEventId : null);
      const entry = { state, record, lastEventId, snapshot: applyTaskRecord(state, record) };
      entries.delete(taskId);
      entries.set(taskId, entry);
      evict();
      return entry.snapshot;
    },
    size() {
      return entries.size;
    },
  };
}

export function createTaskRuntimeSync({
  fetchTask = (taskId, { afterEventId = null } = {}) => api.task(taskId, { afterEventId }),
  cache = createTaskRuntimeCache(),
  now = () => Date.now(),
  retryMs = DEFAULT_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
} = {}) {
  const inFlight = new Map();
  const retries = new Map();

  // One request per task: the 2s poll, an expanded trace and a remount share
  // the same promise, so a slow link cannot stack full-payload downloads.
  async function refresh(taskId) {
    const id = String(taskId || '');
    if (!id) return null;
    const pending = inFlight.get(id);
    if (pending) return pending;
    const retry = retries.get(id);
    if (retry && now() < retry.nextAttemptAt) return null;
    const request = (async () => {
      const task = await fetchTask(id, { afterEventId: cache.cursor(id) });
      retries.delete(id);
      return cache.remember(task);
    })();
    inFlight.set(id, request);
    try {
      return await request;
    } catch (error) {
      // A failing link backs off instead of stacking another 2s retry on top;
      // the first failure still reaches the caller so the UI can speak.
      const failures = (retries.get(id)?.failures || 0) + 1;
      retries.set(id, {
        failures,
        nextAttemptAt: now() + Math.min(retryMs * 2 ** (failures - 1), maxRetryMs),
      });
      throw error;
    } finally {
      if (inFlight.get(id) === request) inFlight.delete(id);
    }
  }

  return { refresh, cache };
}
