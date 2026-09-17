const RUNNING_STATUSES = new Set(['queued', 'running']);
// A task that ends in one of these states never gets a persisted assistant
// message, so both the live bubble and the thread have to render its partial
// text plus the failure reason on their own.
const FAILURE_STATUSES = new Set(['cancelled', 'failed', 'error']);
const HIDDEN_TIMELINE_TOOL_NAMES = new Set(['todo_write', 'write_stdin']);

export function isVisibleTaskTool(value) {
  return !HIDDEN_TIMELINE_TOOL_NAMES.has(String(value || '').trim().toLowerCase());
}

export function hasVisibleTaskTools(state) {
  return Boolean(state?.segments?.some((item) => item.type === 'tool' && isVisibleTaskTool(item.name)));
}

function eventData(event) {
  return { ...((event?.payload && typeof event.payload === 'object') ? event.payload : {}), ...(event || {}) };
}

function activityText(type, data, state) {
  if (type === 'llm_thinking_started') return String(data.message || 'Reasoning has started.');
  if (type === 'agent_progress_delta' || type === 'sub_agent_progress_delta') {
    return String(data.message || data.delta || data.text || '');
  }
  if (type === 'tool_call_started' || type === 'sub_agent_tool_call_started') {
    return String(data.input_summary || data.message || data.tool_name || '');
  }
  if (type === 'tool_call_completed' || type === 'sub_agent_tool_call_completed') {
    return String(data.output_summary || data.message || data.tool_name || '');
  }
  if (type === 'context_compaction_started') return String(data.message || 'Auto-Compacting context');
  if (type === 'context_compaction_completed') return String(data.message || data.summary || 'Context compacted.');
  if (type === 'llm_answer_delta') return state.segments?.some((item) => item.type === 'tool') ? 'Synthesis' : 'Assistant';
  if (type === 'llm_text_phase_resolved' && data.message_phase === 'final') return 'Synthesis';
  return '';
}

function upsertTextSegment(segments, data, occurredAt) {
  const delta = String(data.delta ?? data.text ?? data.message ?? '');
  if (!delta) return segments || [];
  const current = segments || [];
  const source = data.message_phase || 'unknown';
  const explicitId = String(data.text_block_id || '');
  const tail = current[current.length - 1];
  if (!explicitId && tail?.type === 'text' && tail.source === source) {
    const next = current.slice();
    next[next.length - 1] = { ...tail, text: `${tail.text || ''}${delta}` };
    return next;
  }
  const id = explicitId || `text-${occurredAt}`;
  const index = current.findIndex((item) => item.type === 'text' && item.id === id);
  if (index < 0) {
    return [...current, { type: 'text', id, text: delta, source }];
  }
  const next = current.slice();
  next[index] = { ...next[index], text: `${next[index].text || ''}${delta}` };
  return next;
}

function upsertToolSegment(segments, data, status) {
  const current = segments || [];
  const id = String(data.call_id || data.tool_call_id || `tool-${current.length}`);
  const index = current.findIndex((item) => item.type === 'tool' && item.id === id);
  const patch = {
    type: 'tool',
    id,
    name: String(data.tool_name || 'tool'),
    inputSummary: String(data.input_summary || ''),
    outputSummary: String(data.output_summary || ''),
    message: String(data.message || ''),
    toolInput: data.tool_input || null,
    toolResponse: data.tool_response || null,
    toolOutput: String(data.tool_output || ''),
    toolGroup: String(data.tool_group || ''),
    kind: String(data.kind || 'tool'),
    progressEvents: [],
    status,
  };
  if (index < 0) return [...current, patch];
  const next = current.slice();
  next[index] = {
    ...next[index],
    ...patch,
    name: patch.name === 'tool' ? next[index].name : patch.name,
    inputSummary: patch.inputSummary || next[index].inputSummary,
    outputSummary: patch.outputSummary || next[index].outputSummary,
    message: patch.message || next[index].message,
    toolInput: patch.toolInput || next[index].toolInput,
    toolResponse: patch.toolResponse || next[index].toolResponse,
    toolOutput: patch.toolOutput || next[index].toolOutput,
    toolGroup: patch.toolGroup || next[index].toolGroup,
    kind: patch.kind || next[index].kind,
    progressEvents: next[index].progressEvents || [],
  };
  return next;
}

function appendToolOutput(segments, data) {
  const id = String(data.call_id || data.tool_call_id || '');
  const delta = String(data.delta ?? data.text ?? data.content_delta ?? data.content ?? '');
  if (!id || !delta) return segments || [];
  return (segments || []).map((item) => item.type === 'tool' && item.id === id
    ? { ...item, toolOutput: `${item.toolOutput || ''}${delta}`, status: 'running' }
    : item);
}

function appendSubAgentProgress(segments, type, data, occurredAt) {
  const parentId = String(data.parent_call_id || data.parent_tool_call_id || '');
  if (!parentId) return null;
  const isFinished = type === 'sub_agent_finished' || type === 'sub_agent_completed' || type === 'sub_agent_failed';
  const finishedStatus = type === 'sub_agent_failed' || ['failed', 'error'].includes(String(data.status || '').toLowerCase())
    ? 'failed'
    : 'done';
  let current = segments || [];
  if (!current.some((item) => item.type === 'tool' && item.id === parentId) && type === 'sub_agent_started') {
    const prompt = String(data.prompt || data.task || data.message || '');
    current = [...current, {
      type: 'tool',
      id: parentId,
      name: String(data.parent_tool_name || 'dispatch_sub_agent'),
      inputSummary: prompt,
      outputSummary: '',
      message: '',
      toolInput: {
        task: prompt,
        role: String(data.role || data.sub_agent_role || ''),
      },
      toolResponse: null,
      toolOutput: '',
      toolGroup: 'subagent',
      kind: 'tool',
      progressEvents: [],
      status: 'running',
    }];
  }
  let matched = false;
  const next = current.map((item) => {
    if (item.type !== 'tool' || item.id !== parentId) return item;
    matched = true;
    const progress = {
      id: String(data.event_id || `${parentId}-${type}-${occurredAt}`),
      type,
      state: type.endsWith('_completed') || type === 'sub_agent_finished' ? 'completed' : 'running',
      callId: String(data.call_id || data.tool_call_id || ''),
      parentCallId: parentId,
      role: String(data.role || data.sub_agent_role || ''),
      toolName: String(data.tool_name || ''),
      toolInput: data.tool_input || null,
      toolResponse: data.tool_response || null,
      toolOutput: String(data.tool_output || ''),
      summary: String(data.summary || data.message || data.delta || data.output_summary || data.input_summary || data.prompt || ''),
      message: String(data.message || data.delta || ''),
      inputSummary: String(data.input_summary || ''),
      outputSummary: String(data.output_summary || ''),
    };
    return {
      ...item,
      status: isFinished ? finishedStatus : item.status,
      outputSummary: isFinished ? String(data.output_summary || data.summary || item.outputSummary || '') : item.outputSummary,
      progressEvents: [...(item.progressEvents || []), progress],
    };
  });
  return matched ? next : null;
}

export function timeMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatElapsedDuration(start, end) {
  const startAt = timeMs(start);
  const endAt = timeMs(end);
  if (!startAt || !endAt || endAt < startAt) return '';
  const totalSeconds = Math.floor((endAt - startAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function isTaskRunning(value) {
  return RUNNING_STATUSES.has(value?.status || value);
}

export function isFailureStatus(value) {
  return FAILURE_STATUSES.has(String(value?.status || value || '').trim().toLowerCase());
}

export function isCurrentTaskRunning(liveRun, activeTask) {
  return isTaskRunning(liveRun ?? activeTask);
}

export function sanitizeTodoItems(items) {
  if (!Array.isArray(items)) return null;
  const todos = items.map((item) => {
    const content = String(item?.content || '').trim();
    if (!content) return null;
    const status = ['pending', 'in_progress', 'completed'].includes(item?.status) ? item.status : 'pending';
    return { content, status };
  }).filter(Boolean);
  return todos.length ? todos : null;
}

export function applyTaskStreamEvent(current, event) {
  const state = current || {};
  const data = eventData(event);
  const type = String(event?.type || data.type || '');
  const occurredAt = timeMs(event?.created_at || event?.timestamp) || Date.now();
  const next = {
    ...state,
    taskId: event?.task_id || data.task_id || state.taskId || null,
    createdAt: state.createdAt || occurredAt,
    segments: state.segments || [],
  };

  const activity = activityText(type, data, state);
  if (activity) next.activity = activity;

  if (type === 'run_started') return { ...next, status: 'running' };
  if (type === 'llm_thinking_started') return { ...next, status: 'running' };
  if (type === 'llm_answer_delta') {
    const delta = String(data.delta ?? data.text ?? data.message ?? '');
    return delta ? {
      ...next,
      status: 'running',
      text: `${state.text || ''}${delta}`,
      segments: upsertTextSegment(next.segments, data, occurredAt),
      firstTokenAt: state.firstTokenAt || occurredAt,
    } : next;
  }
  if (type === 'llm_text_phase_resolved') {
    const id = String(data.text_block_id || '');
    return {
      ...next,
      segments: next.segments.map((item) => item.type === 'text' && item.id === id
        ? { ...item, source: data.message_phase || item.source }
        : item),
    };
  }
  if (type === 'agent_progress_delta') {
    const text = String(data.message || data.delta || data.text || '');
    return text ? {
      ...next,
      status: 'running',
      segments: upsertTextSegment(next.segments, { ...data, message_phase: 'progress' }, occurredAt),
      firstTokenAt: state.firstTokenAt || occurredAt,
    } : next;
  }
  if (type === 'todo_updated') {
    return { ...next, status: 'running', latestTodos: sanitizeTodoItems(data.items) };
  }
  if (type === 'tool_output_delta') {
    return { ...next, status: 'running', segments: appendToolOutput(next.segments, data) };
  }
  if (type.startsWith('sub_agent_')) {
    const progress = appendSubAgentProgress(next.segments, type, data, occurredAt);
    if (progress) return { ...next, status: 'running', segments: progress };
  }
  if (type === 'tool_call_started' || type === 'sub_agent_tool_call_started') {
    return {
      ...next,
      status: 'running',
      segments: upsertToolSegment(next.segments, data, 'running'),
      firstTokenAt: state.firstTokenAt || occurredAt,
    };
  }
  if (type === 'tool_call_completed' || type === 'sub_agent_tool_call_completed') {
    const failed = data.error || data.tool_response?.error || ['error', 'failed'].includes(String(data.tool_response?.status || '').toLowerCase());
    return { ...next, segments: upsertToolSegment(next.segments, data, failed ? 'failed' : 'done') };
  }
  if (type === 'final_answer') {
    const text = String(data.content ?? data.answer_text ?? data.answer ?? state.text ?? '');
    return { ...next, text, activity: 'Synthesis', firstTokenAt: state.firstTokenAt || occurredAt };
  }
  if (type === 'run_finished') {
    const task = data.task || {};
    const error = String(task.error || data.error || state.error || '');
    return {
      ...next,
      status: data.status || task.status || 'done',
      text: String(task.answer_text || data.answer_text || state.text || ''),
      error,
      completedAt: timeMs(task.completed_at || event?.created_at) || occurredAt,
    };
  }
  return next;
}

export function initialTaskStreamState(task) {
  return {
    taskId: task?.task_id || null,
    status: task?.status || 'running',
    text: '',
    segments: [],
    activity: '',
    latestTodos: null,
    createdAt: timeMs(task?.created_at),
    completedAt: timeMs(task?.completed_at),
    error: String(task?.error || ''),
    firstTokenAt: 0,
  };
}

// The persisted record wins over anything the event log said: status, answer
// text, failure reason and completion time are the runtime's own truth. Kept
// separate from the fold so an incremental reader can overlay it on every read
// instead of baking it into the state it keeps appending to (task-sync.js).
export function applyTaskRecord(state, task) {
  return {
    ...state,
    status: task?.status || state.status,
    text: String(task?.answer_text || state.text || ''),
    error: String(task?.error || state.error || ''),
    completedAt: timeMs(task?.completed_at) || state.completedAt,
  };
}

export function taskStreamState(task) {
  let state = initialTaskStreamState(task);
  for (const event of task?.events || []) state = applyTaskStreamEvent(state, event);
  return applyTaskRecord(state, task);
}

export async function readNdjson(response, onEvent) {
  if (!response.body) throw new Error('Task stream returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent?.(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent?.(JSON.parse(buffer.trim()));
}
