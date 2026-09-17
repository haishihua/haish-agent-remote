import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  composerTextareaHeight,
  fitComposerTextarea,
} from '../src/composer-height.js';

test('an empty or single-line draft stays on the one-line height', () => {
  assert.equal(composerTextareaHeight(0), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(21), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(47), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(undefined), COMPOSER_TEXTAREA_MIN_HEIGHT);
});

test('the height follows the content instead of a reserved box', () => {
  assert.equal(composerTextareaHeight(48), 48);
  assert.equal(composerTextareaHeight(69), 69);
  assert.equal(composerTextareaHeight(111), 111);
});

test('the CSS cap wins once the draft is longer than the box may grow', () => {
  assert.equal(composerTextareaHeight(132), COMPOSER_TEXTAREA_MAX_HEIGHT);
  assert.equal(composerTextareaHeight(200), COMPOSER_TEXTAREA_MAX_HEIGHT);
  assert.equal(composerTextareaHeight(200, { minHeight: '48px', maxHeight: '90px' }), 90);
});

test('the bounds come from the stylesheet, and a missing one never collapses the box', () => {
  assert.equal(composerTextareaHeight(10, { minHeight: '52px' }), 52);
  assert.equal(composerTextareaHeight(10, { minHeight: 'none', maxHeight: 'none' }), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(10, { minHeight: 'auto' }), COMPOSER_TEXTAREA_MIN_HEIGHT);
  assert.equal(composerTextareaHeight(400, { maxHeight: '40px', minHeight: '60px' }), 60);
});

test('fitting measures the content again so a deleted draft shortens the box', () => {
  const textarea = { scrollHeight: 90, style: { height: '48px' } };
  const written = [];
  const styles = { minHeight: '48px', maxHeight: '132px' };
  Object.defineProperty(textarea.style, 'height', {
    get: () => written[written.length - 1] ?? '48px',
    set: (value) => written.push(value),
  });

  assert.equal(fitComposerTextarea(textarea, { getStyles: () => styles }), 90);
  assert.deepEqual(written, ['auto', '90px']);
  assert.equal(fitComposerTextarea(null), 0);
});
