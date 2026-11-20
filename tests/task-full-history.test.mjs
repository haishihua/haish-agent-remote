import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.js';

test('truncated runtime history restores durable full log including early tools', async () => {
  const previous = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (path) => {
    paths.push(String(path));
    const full = String(path).includes('event_view=full');
    return new Response(JSON.stringify(full
      ? { task_id: 'task', events: [{ type: 'tool_call', tool_name: 'read_file' }], events_delta: true }
      : { task_id: 'task', truncated: true, events: [{ type: 'text_delta' }] }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const task = await api.task('task');
    assert.equal(paths.length, 2);
    assert.match(paths[1], /event_view=full$/);
    assert.equal(task.events[0].type, 'tool_call');
    assert.equal(task.events_delta, false);
  } finally { globalThis.fetch = previous; }
});

test('incomplete full log is not accepted as hydrated history', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ truncated: true }),
    { headers: { 'Content-Type': 'application/json' } });
  try { await assert.rejects(api.task('task'), /history is incomplete/); }
  finally { globalThis.fetch = previous; }
});
