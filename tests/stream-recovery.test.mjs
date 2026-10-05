import './support/window-stub.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { reconcileInterruptedRun, interruptedStreamNotice } from '../src/stream-recovery.js';
import { draftRuntimeTask } from '../src/chat-runtime.js';

const run = () => ({ ...draftRuntimeTask(100), taskId: 'task-1', answerText: 'partial', eventLog: [{ type: 'progress' }] });
const conversation = (status, answer = '', messages = []) => ({
  tasks: [{ task_id: 'task-1', status, answer_text: answer, error: status === 'failed' ? 'server failure' : '', completed_at: status === 'running' ? null : '2026-10-05T05:13:21Z' }],
  messages,
});
const persisted = [{ role: 'assistant', task_id: 'task-1', content: 'final answer' }];

test('a disconnected stream yields to the already persisted done answer', () => {
  assert.deepEqual(reconcileInterruptedRun(run(), conversation('done', 'final answer', persisted)), {
    run: null, resolved: true,
  });
});

test('running or queued server tasks retain partial trace and are never fabricated as failed', () => {
  for (const status of ['running', 'queued']) {
    const previous = run();
    const result = reconcileInterruptedRun(previous, conversation(status));
    assert.equal(result.run.status, status);
    assert.equal(result.resolved, false);
    assert.equal(result.running, true);
    assert.deepEqual(result.run.eventLog, previous.eventLog);
    assert.equal(result.run.answerText, 'partial');
    assert.notEqual(result.run.error, 'Load failed');
  }
});

test('done with delayed persistence keeps final answer without offering a failure retry', () => {
  const result = reconcileInterruptedRun(run(), conversation('done', 'final answer'));
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.answerText, 'final answer');
  assert.equal(result.resolved, false);
  assert.equal(result.running, false);
  assert.equal(reconcileInterruptedRun(result.run, conversation('done', 'final answer', persisted)).run, null);
});

test('server failed/cancelled retain the real status, error and trace', () => {
  for (const status of ['failed', 'cancelled', 'error']) {
    const result = reconcileInterruptedRun(run(), conversation(status, 'partial'));
    assert.equal(result.run.status, status);
    assert.equal(result.resolved, true);
    assert.deepEqual(result.run.eventLog, run().eventLog);
    if (status === 'failed') assert.equal(result.run.error, 'server failure');
  }
});

test('offline or unrelated conversation records cannot decide the interrupted task outcome', () => {
  const previous = run();
  for (const snapshot of [null, { tasks: [] }, { tasks: [{ task_id: 'newer-task', status: 'done' }] }]) {
    const result = reconcileInterruptedRun(previous, snapshot);
    assert.equal(result.run, previous);
    assert.equal(result.resolved, false);
    assert.equal(result.run.status, 'running');
  }
  assert.equal(reconcileInterruptedRun(previous, null, { taskId: 'wrong-task', status: 'failed' }).run, previous);
});

test('foreground recovery can move offline → running → done → persisted without restarting a task', () => {
  let previous = run();
  previous = reconcileInterruptedRun(previous, null).run;
  const runningState = { ...previous, status: 'running', answerText: 'more', runtimeHydrated: true };
  previous = reconcileInterruptedRun(previous, null, runningState).run;
  assert.equal(previous, runningState);
  previous = reconcileInterruptedRun(previous, null, { ...runningState, status: 'done', answerText: 'final' }).run;
  assert.equal(previous.status, 'done');
  assert.equal(reconcileInterruptedRun(previous, { messages: persisted }).resolved, true);
});

test('late running snapshots cannot resurrect a completed or cancelled task', () => {
  for (const status of ['done', 'cancelled', 'failed']) {
    const previous = { ...run(), status, answerText: 'final' };
    const result = reconcileInterruptedRun(previous, conversation('running'));
    assert.equal(result.run.status, status);
    assert.equal(result.run.answerText, 'final');
    const fromDetail = reconcileInterruptedRun(previous, null, { ...run(), status: 'queued' });
    assert.equal(fromDetail.run.status, status);
  }
});

test('missing identity is kept uncertain rather than assigned to the newest task', () => {
  const previous = draftRuntimeTask();
  assert.deepEqual(reconcileInterruptedRun(previous, conversation('done')), { run: previous, resolved: false });
});

test('connection notice preserves diagnostic details and warns against resending', () => {
  assert.match(interruptedStreamNotice(new Error('stream-read · HTTP 200 · req-123')), /Do not resend.*stream-read · HTTP 200 · req-123/);
});

test('App unlocks refresh before reconciliation and never makes transport errors task failures', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const branch = app.slice(app.indexOf('// The run was accepted and then the stream broke'), app.indexOf('const selectedThinking'));
  assert.match(branch, /localStreamRef\.current = false;[\s\S]*interruptedRunRef\.current = \{ run: previousRun, notice \};[\s\S]*await refresh\(\{ keep: true \}\);/);
  assert.doesNotMatch(branch, /status: 'failed'|api\.startTask|api\.sendInput/);
  assert.match(app, /reconcileInterruptedRun\(interrupted.run, nextConversation\)/);
  assert.match(app, /reconcileInterruptedRun\(interrupted.run, null, state\)/);
  assert.match(app, /interruptedRunRef\.current\?\.run\?\.taskId \|\| activeTask\?\.task_id/);
  assert.match(app, /document.addEventListener\('visibilitychange', onVisibilityChange\)/);
});
