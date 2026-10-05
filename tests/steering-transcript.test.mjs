import './support/window-stub.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildChatRows, draftRuntimeTask, runtimeTaskFromDetail, runtimeTaskWithEvent, runtimeTaskWithQueuedInput } from '../src/chat-runtime.js';
import { createTaskRuntimeCache, createTaskRuntimeSync } from '../src/task-sync.js';
import { resolveTranscriptImages, transcriptImageRefs } from '../src/transcript-images.js';

const at = (second) => `2026-10-05T16:00:0${second}Z`;
const event = (type, second, payload = {}) => ({ type, event_id: `e${second}`, task_id: 't1', conversation_id: 'c1', created_at: at(second), payload });
const queued = (id = 'i1', second = 2) => ({ input_id: id, event: event('task_input_queued', second, { input_id: id, message: '改原始配置', image_attachments: [{ image_id: 'img1', path: '/tmp/config.png' }] }) });
const applied = (id = 'i1', second = 3) => event('task_input_applied', second, { inputs: [{ input_id: id, message: '改原始配置' }] });
const base = () => ({ ...draftRuntimeTask(Date.parse(at(0))), taskId: 't1', conversationId: 'c1' });
const trace = (run, running = true) => buildChatRows({ conversationId: 'c1', liveRun: run, running, liveReplyPending: !running })[0].traceTimeline;
const inputs = (run) => trace(run).filter((item) => item.kind === 'user_input');
const snapshot = (events, extra = {}) => ({ task_id: 't1', conversation_id: 'c1', status: 'running', events, ...extra });

test('acknowledged correction is inline between previous and following output, with images', () => {
  const started = runtimeTaskWithEvent(base(), event('llm_answer_delta', 1, { delta: '正在检查' }));
  const correction = runtimeTaskWithQueuedInput(started, queued());
  const continued = runtimeTaskWithEvent(correction, event('llm_answer_delta', 4, { delta: '继续修改' }));
  const rows = buildChatRows({ conversationId: 'c1', liveRun: continued, running: true });
  assert.deepEqual(rows.map((row) => row.role), ['agent']);
  const dialogue = rows[0].traceTimeline.filter((item) => ['text', 'user_input'].includes(item.kind));
  assert.deepEqual(dialogue.map((item) => item.text), ['正在检查', '改原始配置', '继续修改']);
  assert.equal(dialogue[1].status, 'pending');
  assert.equal(dialogue[1].images[0].path, '/tmp/config.png');
});

test('same input ID updates pending to applied without duplicates; repeated text keeps distinct IDs', () => {
  const pending = runtimeTaskWithQueuedInput(base(), queued());
  assert.equal(runtimeTaskWithQueuedInput(pending, queued()), pending);
  const run = runtimeTaskWithEvent(pending, applied());
  assert.equal(inputs(run).length, 1);
  assert.equal(inputs(run)[0].status, 'applied');
  const second = runtimeTaskWithQueuedInput(run, queued('i2', 4));
  assert.deepEqual(inputs(second).map((item) => [item.id, item.status]), [['i1', 'applied'], ['i2', 'pending']]);
});

test('applied arriving before HTTP acknowledgement never becomes pending again', () => {
  const run = runtimeTaskWithEvent(base(), applied());
  assert.equal(runtimeTaskWithQueuedInput(run, queued()), run);
  assert.equal(inputs(run)[0].status, 'applied');
});

test('delayed acknowledgement inserts before later output, without disturbing tool events', () => {
  const run = runtimeTaskWithEvent(runtimeTaskWithEvent(base(), event('llm_answer_delta', 1, { delta: '之前' })),
    event('tool_call_started', 4, { call_id: 'call1', tool_name: 'read_file' }));
  const result = runtimeTaskWithQueuedInput(run, queued());
  assert.deepEqual(result.eventLog.map((item) => item.type), ['llm_answer_delta', 'task_input_queued', 'tool_call_started']);
});

test('cache reconciliation preserves queued acknowledgement through stale reads and uses the old cursor', () => {
  const cache = createTaskRuntimeCache();
  cache.remember(snapshot([event('llm_answer_delta', 1, { delta: '之前' })]));
  cache.queueInput('t1', queued(), {});
  assert.equal(cache.cursor('t1'), 'e1');
  const stale = cache.remember(snapshot([event('llm_answer_delta', 1, { delta: '之前' })], { events_delta: false }));
  assert.equal(inputs(stale).length, 1);
  const confirmed = cache.remember(snapshot([queued().event, applied()], { events_delta: true }));
  assert.equal(inputs(confirmed).length, 1);
  assert.equal(inputs(confirmed)[0].status, 'applied');
  assert.equal(confirmed.eventLog.filter((item) => item.type === 'task_input_queued').length, 1);
  assert.equal(cache.cursor('t1'), 'e3');
});

test('a request started before input submission is reconciled when it resolves', async () => {
  let resolve;
  const cache = createTaskRuntimeCache();
  cache.remember(snapshot([]));
  const sync = createTaskRuntimeSync({ cache, fetchTask: () => new Promise((done) => { resolve = done; }) });
  const reading = sync.refresh('t1');
  cache.queueInput('t1', queued(), {});
  resolve(snapshot([], { events_delta: false }));
  assert.equal(inputs(await reading).length, 1);
});

test('finishing or reopening restores corrections in the historical assistant transcript', () => {
  const run = runtimeTaskWithEvent(runtimeTaskWithQueuedInput(base(), queued()), applied());
  const cache = createTaskRuntimeCache();
  cache.retainStream({ ...run, status: 'done' });
  assert.equal(cache.cursor('t1'), null, 'retained streams must not skip unpolled queued events');
  const durable = snapshot([queued().event, applied()], { status: 'done', answer_text: '已修改' });
  const restored = runtimeTaskFromDetail(durable);
  const messages = [
    { message_id: 'm1', task_id: 't1', role: 'user', content: '检查配置' },
    { message_id: 'm2', task_id: 't1', role: 'assistant', content: '已修改' },
  ];
  for (const runtime of [cache.state('t1'), restored]) {
    const rows = buildChatRows({ conversationId: 'c1', messages, runtimeTasks: { t1: runtime }, tasksById: new Map([['t1', durable]]) });
    assert.deepEqual(rows.map((row) => row.role), ['user', 'agent']);
    assert.equal(rows[1].traceTimeline.find((item) => item.kind === 'user_input').status, 'applied');
  }
});

test('missing acknowledgement event does not fabricate a queued instruction', () => {
  const run = base();
  assert.equal(runtimeTaskWithQueuedInput(run, {}), run);
  assert.equal(runtimeTaskWithQueuedInput(run, { event: event('task_input_queued', 2) }), run);
});

test('inline correction images use authenticated previews without mutating desktop timeline', () => {
  const timeline = trace(runtimeTaskWithQueuedInput(base(), queued()));
  const row = { traceTimeline: timeline };
  assert.equal(transcriptImageRefs(row).length, 1);
  const hidden = resolveTranscriptImages(timeline, () => null);
  assert.deepEqual(hidden.find((item) => item.kind === 'user_input').images, []);
  assert.equal(resolveTranscriptImages(timeline, () => null), hidden, 'idle renders reuse timeline identity');
  const resolved = resolveTranscriptImages(timeline, (image) => ({ ...image, previewUrl: 'blob:secured-preview' }));
  assert.equal(resolved.find((item) => item.kind === 'user_input').images[0].previewUrl, 'blob:secured-preview');
  assert.notEqual(timeline.find((item) => item.kind === 'user_input').images[0].previewUrl, 'blob:secured-preview');
  assert.equal(resolveTranscriptImages(timeline, (image) => image), timeline);
});

test('submit does not create correction bubbles or unlock the original stream and retains the completed trace', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(!steering\) \{\s*optimisticUserMessagesRef\.current = \[\.\.\.optimisticUserMessagesRef\.current, optimisticMessage\]/);
  assert.match(app, /const result = await api\.sendInput/);
  assert.match(app, /taskRuntime\.cache\.queueInput\(activeTaskId, result/);
  assert.match(app, /if \(!steering\) localStreamRef\.current = false/);
  assert.match(app, /taskRuntime\.cache\.retainStream\(settledTrace\)/);
  assert.match(app, /composerImagesRef\.current = submittedComposerImages/);
  assert.match(app, /if \(latestRun\) streamedRun = latestRun/);
});
