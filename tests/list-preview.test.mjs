import test from 'node:test';
import assert from 'node:assert/strict';

import { CONVERSATION_PREVIEW_LIMIT } from '../src/conversation-order.js';
import {
  DEFAULT_PREVIEW,
  nextExtraVisible,
  previewRows,
  previewWhenHidden,
} from '../src/list-preview.js';

const rows = (count) => Array.from({ length: count }, (_, index) => ({ conversation_id: `c-${index}` }));

test('a list starts at three rows and shows no toggle when everything fits', () => {
  assert.equal(CONVERSATION_PREVIEW_LIMIT, 3);
  assert.deepEqual(previewRows(rows(2), DEFAULT_PREVIEW).visible.map((row) => row.conversation_id), ['c-0', 'c-1']);
  assert.equal(previewRows(rows(2), DEFAULT_PREVIEW).showToggle, false);
  assert.equal(previewRows(rows(3), DEFAULT_PREVIEW).showToggle, false);
});

test('"Show more" adds three rows at a time until the last one is visible', () => {
  const all = rows(8);
  let extra = DEFAULT_PREVIEW;
  const seen = [];
  for (let step = 0; step < 4; step += 1) {
    const { visible, hiddenCount, showToggle } = previewRows(all, extra);
    seen.push([visible.length, hiddenCount, showToggle]);
    extra = nextExtraVisible(extra, hiddenCount);
  }

  assert.deepEqual(seen, [
    [3, 5, true],
    [6, 2, true],
    [8, 0, true],
    [3, 5, true],
  ]);
});

test('once the last row is visible the button folds back to the default preview', () => {
  const { hiddenCount } = previewRows(rows(4), 3);
  assert.equal(hiddenCount, 0);
  assert.equal(nextExtraVisible(3, 0), DEFAULT_PREVIEW);
  assert.equal(nextExtraVisible(DEFAULT_PREVIEW, 0), DEFAULT_PREVIEW);
});

test('nextExtraVisible never overruns the hidden rows', () => {
  assert.equal(nextExtraVisible(3, 1), 4);
  assert.equal(nextExtraVisible(0, 2), 2);
});

test('folding a list away drops the expansion', () => {
  assert.equal(previewWhenHidden(6, true), 6);
  assert.equal(previewWhenHidden(6, false), DEFAULT_PREVIEW);
  assert.equal(previewWhenHidden(DEFAULT_PREVIEW, false), DEFAULT_PREVIEW);
});

test('a search shows every match with no toggle, whatever the expansion was', () => {
  const all = rows(8);
  const unlimited = Number.POSITIVE_INFINITY;
  assert.deepEqual(previewRows(all, DEFAULT_PREVIEW, unlimited).visible.length, 8);
  assert.equal(previewRows(all, DEFAULT_PREVIEW, unlimited).showToggle, false);
  assert.deepEqual(previewRows(all, 3, unlimited).visible.length, 8);
  assert.equal(previewRows(all, 3, unlimited).showToggle, false);
});
