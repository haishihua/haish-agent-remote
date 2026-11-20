import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { replacedTaskIds } from '../src/task-replies.js';
import { userErrorMessage } from '../src/user-error.js';

test('full retry lineage survives reload and collapses multi-attempt failures', () => {
  const conversation = { tasks: [
    { task_id: 'a', status: 'failed' },
    { task_id: 'b', source_task_id: 'a', status: 'failed' },
    { task_id: 'c', source_task_id: 'b', status: 'running' },
    { task_id: 'node', source_task_id: 'c', rerun_from_node_id: 'step' },
  ] };
  assert.deepEqual([...replacedTaskIds(conversation)], ['a', 'b']);
  assert.deepEqual([...replacedTaskIds(conversation, new Set(['c']))], ['c', 'a', 'b']);
});

test('user errors never include server response text or diagnostic metadata', () => {
  for (const status of [0, 400, 401, 403, 404, 409, 429, 500]) {
    const message = userErrorMessage({ status, message: 'secret /api/conversations/private req-123 HTTP stack' });
    assert.ok(message.length < 110);
    assert.doesNotMatch(message, /secret|\/api|req-|HTTP|stack/);
  }
});

test('directory first paint does not wait for read receipts; error banner only handles connection state', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /void api\.conversationReads\(\)\.then/);
  assert.match(app, /const projectsResponse = await api\.projects\(\)/);
  assert.match(app, /\{connection \? <div className=\{`detail-error-banner/);
  assert.match(app, /replacedIds\.has\(item\.task_id\)/);
});
