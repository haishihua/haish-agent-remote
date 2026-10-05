import { api } from './api.js';
import { runtimeTaskFromDetail, runtimeTaskWithQueuedInput } from './chat-runtime.js';

// Cursor-based runtime task reads. The runtime exposes `after_event_id` plus an
// `events_delta` flag (the desktop client already reads tasks that way); this
// module keeps the phone on the same protocol instead of re-downloading the
// whole event log every two seconds.
//
// 缓存里存的是**桌面形状的 runtime task**（eventLog + 记录字段），不是手机以前
// 那套 segments：行、时间线、工具卡都由桌面组件渲染（见 chat-runtime.js /
// chat-view.jsx），这里只负责“折在哪儿”和“从哪一条开始要”。
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
    // Keep local stream/HTTP acknowledgements without advancing the poll cursor:
    // queued input responses may arrive ahead of earlier, unseen task events.
    retainStream(snapshot) {
      if (!snapshot?.taskId) return null;
      const previous = entries.get(snapshot.taskId);
      entries.set(snapshot.taskId, { ...previous, snapshot, record: null, lastEventId: null });
      evict();
      return snapshot;
    },
    queueInput(taskId, result, options, seed = null) {
      const previous = entries.get(taskId);
      const base = seed || previous?.snapshot;
      if (!base) return null;
      const snapshot = runtimeTaskWithQueuedInput(base, result, options);
      const queuedInputs = new Map(previous?.queuedInputs || []);
      const inputId = result?.event?.payload?.input_id || result?.input_id;
      if (result?.event?.type === 'task_input_queued' && inputId) queuedInputs.set(inputId, { result, options });
      entries.set(taskId, { ...previous, snapshot, queuedInputs });
      evict();
      return snapshot;
    },
    // Appends the payload to the cached log only when the runtime confirmed
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
      let snapshot = runtimeTaskFromDetail(task, previous?.snapshot || null);
      const queuedInputs = new Map(previous?.queuedInputs || []);
      for (const [inputId, queued] of queuedInputs) {
        const confirmed = events.some((event) => (event.type === 'task_input_queued' && event.payload?.input_id === inputId)
          || (event.type === 'task_input_applied' && event.payload?.inputs?.some((input) => input.input_id === inputId)));
        if (confirmed) queuedInputs.delete(inputId);
        else snapshot = runtimeTaskWithQueuedInput(snapshot, queued.result, queued.options);
      }
      const lastEventId = events.length
        ? String(events[events.length - 1]?.event_id || '') || (append ? previous.lastEventId : null)
        : (append ? previous.lastEventId : null);
      const entry = { snapshot, record, lastEventId, queuedInputs };
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
