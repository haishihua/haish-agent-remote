import assert from 'node:assert/strict';
import test from 'node:test';
import { api, requestWithTimeout } from '../src/api.js';
import {
  diagnoseRequestError, readRequestDiagnostics,
  REQUEST_DIAGNOSTICS_KEY, REQUEST_DIAGNOSTICS_LIMIT,
} from '../src/request-diagnostics.js';

async function withFetch(fetch, run) {
  const original = globalThis.fetch;
  const warn = console.warn;
  globalThis.fetch = fetch;
  console.warn = () => {};
  try { await run(); } finally { globalThis.fetch = original; console.warn = warn; }
}

function check(stage, inspect = () => {}) {
  return (error) => {
    assert.equal(error.requestDiagnostic.stage, stage);
    assert.match(error.message, /req-[a-z0-9]+-[a-z0-9]+/);
    assert.match(error.requestDiagnostic.time, /^\d{4}-/);
    inspect(error, error.requestDiagnostic);
    return true;
  };
}

test('occasional WebKit fetch exception identifies request and stage', async () => {
  await withFetch(async () => { throw new DOMException('The string did not match the expected pattern.', 'SyntaxError'); }, async () => {
    await assert.rejects(api.conversation('conversation-1'), check('fetch', (error, record) => {
      assert.equal(record.path, '/api/conversations/conversation-1');
      assert.equal(record.method, 'GET');
      assert.equal(record.status, null);
      assert.equal(record.type, 'SyntaxError');
      assert.match(error.message, /The string did not match the expected pattern/);
    }));
  });
});

test('empty and HTML responses identify JSON parsing without retaining response text', async () => {
  for (const body of ['', '<html>private message and token SECRET</html>']) {
    await withFetch(async () => new Response(body, { headers: { 'Content-Type': 'text/html' } }), async () => {
      await assert.rejects(api.task('task-1', { afterEventId: 'SECRET-CURSOR' }), check('json-parse', (error, record) => {
        assert.equal(record.status, 200);
        assert.equal(record.contentType, 'text/html');
        assert.equal(record.responseChars, body.length);
        assert.equal(record.path, '/api/tasks/task-1');
        assert.doesNotMatch(JSON.stringify(record) + error.message, /SECRET|private message|<html>/);
      }));
    });
  }
});

test('response read failure is distinct from parsing failure', async () => {
  await withFetch(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('Load failed'); } }), async () => {
    await assert.rejects(api.agents(), check('json-read', (_error, record) => {
      assert.equal(record.type, 'TypeError');
      assert.equal(record.status, 200);
    }));
  });
});

test('timeout while reading the body keeps timeout classification and original HTTP status', async () => {
  await withFetch(async (_path, init) => ({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  }), async () => {
    await assert.rejects(requestWithTimeout('/remote/status', 5), check('timeout', (error, record) => {
      assert.equal(record.status, 200);
      assert.equal(error.status, 0);
      assert.match(error.message, /^Connection timed out/);
    }));
  });
});

test('HTTP status is preserved for existing model fallback and retry logic', async () => {
  await withFetch(async () => new Response('{"detail":"Forbidden"}', { status: 403 }), async () => {
    await assert.rejects(api.projects(), check('http', (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /^Forbidden \[/);
    }));
  });
});

test('task stream parse errors include line and preserve acceptance order', async () => {
  const events = [];
  await withFetch(async () => new Response('{"type":"hello"}\nPRIVATE-RESPONSE\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), async () => {
    await assert.rejects(api.startTask({ conversation_id: 'abc' }, 'PRIVATE-MESSAGE', [], {},
      (event) => events.push(event.type), () => events.push('accepted')), check('stream-parse', (error, record) => {
        assert.deepEqual(events, ['accepted', 'hello']);
        assert.equal(record.streamLine, 2);
        assert.equal(record.method, 'POST');
        assert.equal(record.path, '/remote/conversations/abc/tasks');
        assert.doesNotMatch(JSON.stringify(record) + error.message, /PRIVATE/);
      }));
  });
});

test('stream read and handler failures are distinguishable', async () => {
  await withFetch(async () => ({ ok: true, status: 200, headers: new Headers(), body: {
    getReader: () => ({ read: async () => { throw new TypeError('Load failed'); } }),
  } }), async () => {
    await assert.rejects(api.startTask({ conversation_id: 'abc' }, '', [], {}, () => {}), check('stream-read'));
  });
  await withFetch(async () => new Response('{"type":"hello"}\n'), async () => {
    await assert.rejects(api.startTask({ conversation_id: 'abc' }, '', [], {}, () => {
      throw new Error('PRIVATE-EVENT');
    }), check('stream-handler', (error) => assert.doesNotMatch(error.message, /PRIVATE/)));
  });
});

test('image diagnostics strip image path query and identify blob-read failure', async () => {
  await withFetch(async () => ({ ok: true, status: 200, headers: new Headers(), blob: async () => { throw new TypeError('Load failed'); } }), async () => {
    await assert.rejects(api.imagePreview('abc', '/private/photo-SECRET.png'), check('blob-read', (error, record) => {
      assert.equal(record.path, '/api/conversations/abc/messages/images/preview');
      assert.doesNotMatch(error.message + JSON.stringify(record), /SECRET|private|image_path/);
    }));
  });
});

test('diagnostics persist a bounded metadata-only history and survive unavailable storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const warn = console.warn;
  let saved;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => saved || null,
    setItem: (key, value) => { assert.equal(key, REQUEST_DIAGNOSTICS_KEY); saved = value; },
  } });
  console.warn = () => {};
  try {
    for (let i = 0; i < 35; i += 1) {
      const error = diagnoseRequestError(new Error('secret token Bearer PRIVATE'), {
        path: '/api/tasks/abc?token=PRIVATE', stage: 'fetch', startedAt: Date.now(),
        headers: { Authorization: 'Bearer PRIVATE' }, body: 'PRIVATE',
      });
      assert.equal(diagnoseRequestError(error, {}), error); // no duplicate log
    }
    assert.equal(readRequestDiagnostics().length, REQUEST_DIAGNOSTICS_LIMIT);
    assert.doesNotMatch(saved, /PRIVATE|Bearer|headers|body|stack/);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable'); } });
    assert.doesNotThrow(() => diagnoseRequestError(new Error('x'), {
      path: 'https://secret.invalid/?token=PRIVATE', stage: 'build-url', startedAt: Date.now(),
    }));
    assert.equal(readRequestDiagnostics().at(-1).path, '(invalid route)');
  } finally {
    console.warn = warn;
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
