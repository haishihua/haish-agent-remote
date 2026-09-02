import assert from 'node:assert/strict';
import test from 'node:test';

import { RECONNECT_TIMEOUT_MS, api, runtimeConnectionState } from '../src/api.js';

test('runtime reconnecting state becomes a recoverable timeout after three polls', () => {
  const offlineSince = 10_000;
  assert.deepEqual(runtimeConnectionState(false, offlineSince, offlineSince + RECONNECT_TIMEOUT_MS - 1), {
    timedOut: false,
    message: 'Reconnecting to Haish…',
  });
  assert.deepEqual(runtimeConnectionState(false, offlineSince, offlineSince + RECONNECT_TIMEOUT_MS), {
    timedOut: true,
    message: 'Unable to connect to Haish. Open the desktop app to retry.',
  });
  assert.equal(runtimeConnectionState(true, offlineSince, offlineSince + RECONNECT_TIMEOUT_MS), null);
});

test('server errors become reconnecting state when the Haish runtime is offline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => path === '/remote/status'
    ? new Response(JSON.stringify({ runtime_online: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 500 });

  try {
    await assert.rejects(api.projects(), { message: 'Reconnecting to Haish…', status: 500 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pairing submits only the code because the server identifies the remote device', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_path, init = {}) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await api.pair('12345678');
    assert.deepEqual(requestBody, { code: '12345678' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image uploads and task starts use the desktop image attachment protocol', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/messages/images') {
      return new Response(JSON.stringify({ image_id: 'image-1', path: '/tmp/shot.png', mime: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };

  try {
    const file = new Blob(['image'], { type: 'image/png' });
    await api.uploadImage('conversation-1', file);
    const attachments = [{ image_id: 'image-1', path: '/tmp/shot.png', mime: 'image/png' }];
    await api.startTask({ conversation_id: 'conversation-1' }, 'Look at this', attachments, {}, () => {});

    assert.equal(calls[0].path, '/api/messages/images');
    assert.equal(calls[0].init.body.get('conversation_id'), 'conversation-1');
    assert.equal(calls[0].init.body.get('file').type, 'image/png');
    assert.equal(calls[0].init.body.get('file').size, file.size);
    assert.deepEqual(JSON.parse(calls[1].init.body).image_attachments, attachments);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
