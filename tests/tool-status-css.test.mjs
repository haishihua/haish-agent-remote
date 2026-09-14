import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

function selectors(source) {
  const found = [];
  for (const block of source.split('}')) {
    const brace = block.lastIndexOf('{');
    if (brace < 0) continue;
    for (const selector of block.slice(0, brace).split(',')) {
      const trimmed = selector.trim();
      if (trimmed) found.push(trimmed);
    }
  }
  return found;
}

// The group class carries the aggregate status of the whole run, so it must not
// reach the status dot of nested tool cards: one failed call used to turn every
// sibling tool red, which is what "everything failed" on the phone was.
test('tool group status colours only apply to the group head', () => {
  const leaked = selectors(css).filter((selector) => (
    selector.includes('.tool-trace-group')
    && selector.includes('.tool-trace-status')
    && !selector.includes('> .tool-trace-head')
  ));

  assert.deepEqual(leaked, []);
});

test('each tool status still has its own colour rule', () => {
  const found = selectors(css);
  for (const selector of [
    '.tool-trace-card.done .tool-trace-status',
    '.tool-trace-card.failed .tool-trace-status',
    '.tool-trace-card.cancelled .tool-trace-status',
    '.tool-trace-group.done > .tool-trace-head .tool-trace-status',
    '.tool-trace-group.failed > .tool-trace-head .tool-trace-status',
  ]) {
    assert.ok(found.includes(selector), `missing css rule for ${selector}`);
  }
});
