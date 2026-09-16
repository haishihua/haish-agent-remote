import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTaskStreamEvent,
  formatElapsedDuration,
  hasVisibleTaskTools,
  isCurrentTaskRunning,
  isFailureStatus,
  isVisibleTaskTool,
  readNdjson,
  taskStreamState,
} from '../src/task-stream.js';

test('terminal live task state overrides a stale running conversation snapshot', () => {
  assert.equal(isCurrentTaskRunning({ status: 'done' }, { status: 'running' }), false);
  assert.equal(isCurrentTaskRunning(null, { status: 'running' }), true);
});

test('failure statuses cover every stop the runtime reports, however they are spelled', () => {
  assert.equal(isFailureStatus('cancelled'), true);
  assert.equal(isFailureStatus('FAILED'), true);
  assert.equal(isFailureStatus('error'), true);
  assert.equal(isFailureStatus({ status: 'failed' }), true);
  assert.equal(isFailureStatus('done'), false);
  assert.equal(isFailureStatus(undefined), false);
});

test('internal todo and process polling tools stay out of the visible timeline', () => {
  assert.equal(isVisibleTaskTool('exec_command'), true);
  assert.equal(isVisibleTaskTool('read_file'), true);
  assert.equal(isVisibleTaskTool('todo_write'), false);
  assert.equal(isVisibleTaskTool('write_stdin'), false);
});

test('elapsed disclosure requires a visible tool call', () => {
  assert.equal(hasVisibleTaskTools({ segments: [{ type: 'text', text: 'Hello' }] }), false);
  assert.equal(hasVisibleTaskTools({ segments: [{ type: 'tool', name: 'write_stdin' }] }), false);
  assert.equal(hasVisibleTaskTools({ segments: [{ type: 'tool', name: 'read_file' }] }), true);
});

test('stream deltas update live text and final answer replaces the trace text', () => {
  let state = applyTaskStreamEvent(null, { type: 'run_started', task_id: 'task-1', created_at: '2026-09-02T00:00:00Z' });
  state = applyTaskStreamEvent(state, { type: 'llm_answer_delta', payload: { delta: 'Hel' }, created_at: '2026-09-02T00:00:02Z' });
  state = applyTaskStreamEvent(state, { type: 'llm_answer_delta', payload: { delta: 'lo' }, created_at: '2026-09-02T00:00:03Z' });
  state = applyTaskStreamEvent(state, { type: 'final_answer', payload: { content: '**Hello**' }, created_at: '2026-09-02T00:00:04Z' });
  state = applyTaskStreamEvent(state, { type: 'run_finished', payload: { status: 'done', task: { answer_text: '**Hello**', completed_at: '2026-09-02T00:00:07Z' } } });

  assert.equal(state.text, '**Hello**');
  assert.equal(state.status, 'done');
  assert.equal(formatElapsedDuration(state.firstTokenAt, state.completedAt), '5s');
});

test('persisted active task rebuilds its streamed text', () => {
  const state = taskStreamState({
    task_id: 'task-2',
    status: 'running',
    created_at: '2026-09-02T00:00:00Z',
    events: [
      { type: 'llm_answer_delta', payload: { delta: 'A' }, created_at: '2026-09-02T00:00:01Z' },
      { type: 'llm_answer_delta', payload: { delta: 'B' }, created_at: '2026-09-02T00:00:02Z' },
    ],
  });
  assert.equal(state.text, 'AB');
  assert.equal(state.status, 'running');
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].text, 'AB');
});

test('adjacent progress deltas are one readable timeline paragraph', () => {
  let state = applyTaskStreamEvent(null, { type: 'agent_progress_delta', payload: { message: '先检查' } });
  state = applyTaskStreamEvent(state, { type: 'agent_progress_delta', payload: { message: '项目。' } });
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].text, '先检查项目。');
});

test('failed task keeps commentary separate from its final error', () => {
  const state = taskStreamState({
    task_id: 'task-failed',
    status: 'failed',
    error: 'Request failed: SSL error',
    events: [
      { type: 'llm_answer_delta', payload: { delta: '我会先检查项目。', text_block_id: 'block-1', message_phase: 'unknown' } },
      { type: 'llm_text_phase_resolved', payload: { text_block_id: 'block-1', message_phase: 'commentary' } },
      { type: 'run_finished', payload: { status: 'failed', error: 'Request failed: SSL error', task: { status: 'failed', error: 'Request failed: SSL error' } } },
    ],
  });

  assert.equal(state.text, '我会先检查项目。');
  assert.equal(state.error, 'Request failed: SSL error');
  assert.deepEqual(state.segments[0], {
    type: 'text',
    id: 'block-1',
    text: '我会先检查项目。',
    source: 'commentary',
  });
});

test('todo updates replace the current task plan without becoming tool cards', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'todo_updated',
    payload: { items: [
      { content: 'Inspect the projects', status: 'completed' },
      { content: 'Run acceptance checks', status: 'in_progress' },
      { content: '', status: 'pending' },
    ] },
  });
  assert.deepEqual(state.latestTodos, [
    { content: 'Inspect the projects', status: 'completed' },
    { content: 'Run acceptance checks', status: 'in_progress' },
  ]);
  assert.deepEqual(state.segments, []);

  state = applyTaskStreamEvent(state, {
    type: 'todo_updated',
    payload: { items: [{ content: 'Run acceptance checks', status: 'completed' }] },
  });
  assert.deepEqual(state.latestTodos, [{ content: 'Run acceptance checks', status: 'completed' }]);
});

test('backend tool events become a live card with backend summaries', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'tool_call_started',
    created_at: '2026-09-02T00:00:01Z',
    payload: { call_id: 'call-1', tool_name: 'read_file', input_summary: 'README.md' },
  });
  state = applyTaskStreamEvent(state, {
    type: 'tool_call_completed',
    created_at: '2026-09-02T00:00:02Z',
    payload: { call_id: 'call-1', tool_name: 'read_file', output_summary: 'Read file content successfully.' },
  });

  assert.deepEqual(state.segments[0], {
    type: 'tool',
    id: 'call-1',
    name: 'read_file',
    inputSummary: 'README.md',
    outputSummary: 'Read file content successfully.',
    message: '',
    toolInput: null,
    toolResponse: null,
    toolOutput: '',
    toolGroup: '',
    kind: 'tool',
    progressEvents: [],
    status: 'done',
  });
  assert.equal(state.activity, 'Read file content successfully.');
});

test('tool payloads and nested sub-agent progress stay attached to the parent card', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'tool_call_started',
    created_at: '2026-09-02T00:00:01Z',
    payload: {
      call_id: 'parent-1',
      tool_name: 'dispatch_sub_agent',
      tool_group: 'internal',
      tool_input: { role: 'reviewer', task: 'Review the patch' },
    },
  });
  state = applyTaskStreamEvent(state, {
    type: 'sub_agent_tool_call_started',
    created_at: '2026-09-02T00:00:02Z',
    payload: {
      parent_call_id: 'parent-1',
      call_id: 'child-1',
      tool_name: 'read_file',
      tool_input: { path: 'src/App.jsx' },
    },
  });
  state = applyTaskStreamEvent(state, {
    type: 'tool_call_completed',
    created_at: '2026-09-02T00:00:03Z',
    payload: {
      call_id: 'parent-1',
      tool_name: 'dispatch_sub_agent',
      tool_response: { status: 'ok', data: { answer: 'Looks good.' } },
    },
  });

  assert.deepEqual(state.segments[0].toolInput, { role: 'reviewer', task: 'Review the patch' });
  assert.equal(state.segments[0].progressEvents[0].toolName, 'read_file');
  assert.equal(state.segments[0].toolResponse.data.answer, 'Looks good.');
  assert.equal(state.segments.length, 1);
});

test('persisted sub-agent events synthesize a parent card when the tool start is absent', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'sub_agent_started',
    payload: {
      parent_call_id: 'parent-history-1',
      parent_tool_name: 'dispatch_sub_agent',
      role: 'reviewer',
      prompt: 'Review the design document without editing it.',
    },
  });
  state = applyTaskStreamEvent(state, {
    type: 'sub_agent_answer_delta',
    payload: { parent_call_id: 'parent-history-1', role: 'reviewer', delta: 'One issue found.' },
  });
  state = applyTaskStreamEvent(state, {
    type: 'sub_agent_finished',
    payload: { parent_call_id: 'parent-history-1', role: 'reviewer', status: 'ok', output_summary: 'One issue found.' },
  });

  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].name, 'dispatch_sub_agent');
  assert.deepEqual(state.segments[0].toolInput, {
    task: 'Review the design document without editing it.',
    role: 'reviewer',
  });
  assert.equal(state.segments[0].status, 'done');
  assert.equal(state.segments[0].outputSummary, 'One issue found.');
  assert.deepEqual(state.segments[0].progressEvents.map((event) => event.type), [
    'sub_agent_started',
    'sub_agent_answer_delta',
    'sub_agent_finished',
  ]);
});

test('shell output deltas remain on the shell card', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'tool_call_started',
    payload: { call_id: 'shell-1', tool_name: 'exec_command', tool_input: { command: 'npm test' } },
  });
  state = applyTaskStreamEvent(state, {
    type: 'tool_output_delta',
    payload: { call_id: 'shell-1', delta: 'all tests passed\n' },
  });
  assert.equal(state.segments[0].toolOutput, 'all tests passed\n');
});

test('text phase resolution marks the final synthesis block', () => {
  let state = applyTaskStreamEvent(null, {
    type: 'llm_answer_delta',
    created_at: '2026-09-02T00:00:01Z',
    payload: { delta: 'Final answer', text_block_id: 'block-1', message_phase: 'unknown' },
  });
  state = applyTaskStreamEvent(state, {
    type: 'llm_text_phase_resolved',
    created_at: '2026-09-02T00:00:02Z',
    payload: { text_block_id: 'block-1', message_phase: 'final' },
  });

  assert.equal(state.segments[0].source, 'final');
  assert.equal(state.activity, 'Synthesis');
});

test('NDJSON reader emits complete events across response chunks', async () => {
  const source = [
    '{"type":"run_started"}\n{"type":"llm_answer_',
    'delta","payload":{"delta":"Hi"}}\n',
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of source) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
  const events = [];

  await readNdjson(response, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), ['run_started', 'llm_answer_delta']);
  assert.equal(events[1].payload.delta, 'Hi');
});

test('only the runtime run_finished event finishes the live task', () => {
  let state = applyTaskStreamEvent(null, { type: 'run_started', task_id: 'task-1' });
  state = applyTaskStreamEvent(state, { type: 'final_answer', payload: { content: 'All done.' } });
  assert.equal(state.status, 'running');

  state = applyTaskStreamEvent(state, { type: 'run_finished', payload: { status: 'done', task: { task_id: 'task-1', status: 'done' } } });
  assert.equal(state.status, 'done');
});
