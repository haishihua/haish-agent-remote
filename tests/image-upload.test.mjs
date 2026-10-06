import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { api } from '../src/api.js';
import { createImageUploader, hasBlockedImageUploads, imageUploadErrorMessage } from '../src/image-upload.js';

const file = { type: 'image/png', size: 100, name: 'photo.png' };
const draft = (id = 'a') => ({ id, file, previewUrl: 'blob:original', uploading: true, error: '' });
const result = { image_id: 'uploaded', path: '/tmp/photo.png', mime: 'image/png' };
function fixture(uploadFile, options = {}) {
  let images = [draft()];
  const uploader = createImageUploader({ getImages: () => images, setImages: (next) => { images = next; }, uploadFile, ...options });
  return { uploader, get images() { return images; }, set images(next) { images = next; } };
}

test('blocked attachments prevent text-only sends until every image is ready or removed', () => {
  assert.equal(hasBlockedImageUploads([]), false);
  for (const image of [draft(), { ...draft(), uploading: false, error: 'Failed' },
    { ...draft(), uploading: false }, { imageId: 'id' }, { path: '/tmp/file' }]) {
    assert.equal(hasBlockedImageUploads([image]), true);
  }
  const ready = { uploading: false, error: '', imageId: 'id', path: '/tmp/file' };
  assert.equal(hasBlockedImageUploads([ready]), false);
  assert.equal(hasBlockedImageUploads([ready, draft()]), true);
});

test('upload failure retains the original file/preview and manual retry recovers', async () => {
  let attempts = 0;
  const f = fixture(async (actualFile) => {
    assert.equal(actualFile, file);
    if (++attempts === 1) throw new Error('Load failed [POST /api/messages/images · secret diagnostic]');
    return result;
  });
  await f.uploader.upload('a');
  assert.equal(f.images[0].file, file);
  assert.equal(f.images[0].previewUrl, 'blob:original');
  assert.equal(f.images[0].retryable, true);
  assert.equal(f.images[0].uploading, false);
  assert.equal(hasBlockedImageUploads(f.images), true);
  assert.doesNotMatch(f.images[0].error, /POST|secret|images/);
  await f.uploader.upload('a');
  assert.equal(f.images[0].error, '');
  assert.equal(f.images[0].imageId, result.image_id);
  assert.equal(hasBlockedImageUploads(f.images), false);
  await f.uploader.upload('a');
  assert.equal(attempts, 2, 'successful attachments must not be reuploaded');
});

test('duplicate retry taps share one request; other uploads complete independently', async () => {
  const resolves = [];
  const f = fixture(() => new Promise((resolve) => resolves.push(resolve)));
  f.images = [draft('a'), draft('b')];
  const first = f.uploader.upload('a');
  assert.equal(f.uploader.upload('a'), first);
  const second = f.uploader.upload('b');
  resolves[1]({ ...result, image_id: 'b' });
  await second;
  resolves[0]({ ...result, image_id: 'a' });
  await first;
  assert.deepEqual(f.images.map((image) => image.imageId), ['a', 'b']);
});

test('removal aborts in-flight upload and ignores late success without restoring the image', async () => {
  let finish;
  let signal;
  const f = fixture((_file, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = f.uploader.upload('a');
  f.uploader.cancel('a');
  f.images = [];
  assert.equal(signal.aborted, true);
  finish(result);
  await pending;
  assert.deepEqual(f.images, []);
});

test('unmount/cancelAll prevents cancelled responses from changing remaining drafts', async () => {
  let reject;
  const f = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = f.uploader.upload('a');
  const before = f.images;
  f.uploader.cancelAll();
  reject(new Error('Aborted'));
  await pending;
  assert.equal(f.images, before);
});

test('timeout aborts request, unlocks draft and gives a concise retryable error', async () => {
  const f = fixture((_file, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }), { timeoutMs: 5 });
  await f.uploader.upload('a');
  assert.equal(f.images[0].uploading, false);
  assert.match(f.images[0].error, /timed out/);
  assert.equal(f.images[0].retryable, true);
});

test('invalid files are not uploaded or retried; invalid success responses remain blocked', async () => {
  let count = 0;
  const f = fixture(async () => { count++; return {}; });
  f.images = [{ ...draft(), file: { type: 'image/svg+xml', size: 10 } }];
  await f.uploader.upload('a');
  assert.equal(count, 0);
  f.images = [draft()];
  await f.uploader.upload('a');
  assert.equal(count, 1);
  assert.equal(f.images[0].retryable, true);
  assert.equal(hasBlockedImageUploads(f.images), true);
});

test('errors are safe summaries rather than arbitrary backend or diagnostic payloads', () => {
  assert.match(imageUploadErrorMessage({ status: 413 }), /too large/);
  assert.match(imageUploadErrorMessage({ requestDiagnostic: { status: 401 } }), /authorized/);
  assert.match(imageUploadErrorMessage(new Error('Bearer secret-token')), /^Image upload failed/);
});

test('multipart uploads forward cancellation without setting JSON content type', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.headers['Content-Type'], undefined);
    return new Response(JSON.stringify(result));
  };
  try { await api.uploadImage('conversation', new Blob(['image'], { type: 'image/png' }), { signal: controller.signal }); }
  finally { globalThis.fetch = originalFetch; }
});

test('retry UI and all send paths use the same attachment guard', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /className="composer-image-retry"/);
  assert.match(app, /image\.error && image\.retryable/);
  assert.match(app, /onClick=\{\(\) => imageUploader\.upload\(image\.id\)\}/);
  assert.match(app, /hasBlockedImageUploads\(composerImagesRef\.current\)\) return/);
  assert.match(app, /data-blocked=\{busy \|\| composerPending \|\| hasBlockedImageUploads\(composerImages\)/);
  assert.match(app, /disabled=\{busy \|\| composerPending \|\| hasBlockedImageUploads\(composerImages\)/);
  assert.match(app, /imageUploader\.cancel\(imageId\)/);
  assert.match(app, /imageUploader\.cancelAll\(\)/);
  assert.doesNotMatch(app, /error: nextError\.message/);
});
