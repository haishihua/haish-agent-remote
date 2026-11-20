import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const view = await readFile(new URL('../src/chat-view.jsx', import.meta.url), 'utf8');

test('mobile hides only agent identity, retaining timeline metadata', () => {
  assert.match(css, /\.agent-response > \.chat-bubble-meta > \.chat-bubble-meta-main\s*\{\s*display: none;/);
  assert.match(css, /\.agent-response > \.chat-bubble-meta\s*\{\s*padding-left: 0;/);
});

test('Streamdown inline code is excluded from mobile gold code override', () => {
  assert.match(css, /code:not\(\[data-streamdown="code-block-body"\] code\):not\(\[data-streamdown="inline-code"\]\)/);
});

test('trace observer watches full message row, not an empty trailing sentinel', () => {
  assert.match(view, /key=\{row.id\} ref=\{needsTrace/);
  assert.match(view, /has-execution-trace/);
  assert.match(css, /\.chat-row:not\(\.has-execution-trace\) \.agent-response > \.chat-bubble-meta/);
  assert.doesNotMatch(css, /chat-bubble-meta:not\(:has/);
  assert.doesNotMatch(view, /<span ref=\{\(node\) => attachRow/);
  assert.match(view, /requestedTracesRef.current.get\(taskId\) === node/);
});
