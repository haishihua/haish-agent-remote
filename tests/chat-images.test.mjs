import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_IMAGE_MAX_BYTES,
  chatImageValidationError,
  messageImageRefs,
} from '../src/chat-images.js';

test('chat images follow the desktop limits and message refs are deduplicated', () => {
  assert.equal(chatImageValidationError({ type: 'image/png', size: CHAT_IMAGE_MAX_BYTES }), '');
  assert.equal(chatImageValidationError({ type: 'image/svg+xml', size: 10 }), 'Unsupported image type.');
  assert.equal(chatImageValidationError({ type: 'image/png', size: CHAT_IMAGE_MAX_BYTES + 1 }), 'Image must be 10 MB or smaller.');
  assert.deepEqual(messageImageRefs(
    { content: [{ kind: 'text', text: 'Look' }, { kind: 'image', url: '/tmp/shot.png' }] },
    { image_attachments: [{ image_id: 'same', path: '/tmp/shot.png' }, { image_id: 'two', path: '/tmp/two.jpg' }] },
  ).map((ref) => ref.path), ['/tmp/shot.png', '/tmp/two.jpg']);
});

test('legacy desktop image markers are restored after history reload', () => {
  const message = {
    content: 'Inspect this\n[user attached image #1: /tmp/restored.png]\nThe user attached the image(s) above.',
  };
  assert.deepEqual(messageImageRefs(message, {}).map((ref) => ref.path), ['/tmp/restored.png']);
});
