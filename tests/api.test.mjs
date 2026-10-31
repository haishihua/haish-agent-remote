import assert from 'node:assert/strict';
import test from 'node:test';

import { RECONNECT_TIMEOUT_MS, api, requestWithTimeout, runtimeConnectionState } from '../src/api.js';

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

test('startup status requests time out instead of leaving the app loading forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_path, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });

  try {
    await assert.rejects(requestWithTimeout('/remote/status', 5), {
      message: /^Connection timed out\. Make sure Haish is running on your computer\. \[GET \/remote\/status · timeout · AbortError/,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server errors become reconnecting state when the Haish runtime is offline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => path === '/remote/status'
    ? new Response(JSON.stringify({ runtime_online: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 500 });

  try {
    await assert.rejects(api.projects(), {
      message: /^Reconnecting to Haish… \[GET \/api\/projects · http · Error · HTTP 500/,
      status: 500,
    });
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

test('conversation reads use the adapter canonical read-marker endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push([path, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    return new Response(JSON.stringify(path.endsWith('conversation-1')
      ? { conversation_id: 'conversation-1', seen_at_ms: 1234 }
      : { seen_at: { 'conversation-1': 1234 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    assert.deepEqual(await api.conversationReads(), { seen_at: { 'conversation-1': 1234 } });
    assert.equal((await api.markConversationRead('conversation-1', 1234)).seen_at_ms, 1234);
    assert.deepEqual(calls, [
      ['/remote/conversation-reads', 'GET', null],
      ['/remote/conversation-reads/conversation-1', 'PUT', { seen_at_ms: 1234 }],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('current conversation route read is authenticated GET and preserves the exact ID', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const route = { llm_config_id: 'oauth-record', model_id: 'non-default', reasoning_effort: 'xhigh' };
  globalThis.fetch = async (path, init = {}) => {
    calls.push([path, init.method || 'GET']);
    return Response.json(route);
  };
  try {
    assert.deepEqual(await api.conversationRunConfig('conv 1'), route);
    assert.deepEqual(calls, [['/api/conversations/conv%201/run-config', 'GET']]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('only unsupported current-route reads allow compatibility fallback, not auth or transport failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [403, 404, 401, 500]) {
      globalThis.fetch = async () => status === 500
        ? Response.json({ runtime_online: true }, { status: 500 })
        : Response.json({ detail: 'test failure' }, { status });
      if (status === 403 || status === 404) assert.equal(await api.conversationRunConfig('conv'), null);
      else await assert.rejects(api.conversationRunConfig('conv'), (error) => error.status === status);
    }
    globalThis.fetch = async () => { throw new TypeError('test offline'); };
    await assert.rejects(api.conversationRunConfig('conv'), /Network request failed/);
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
    const annotations = [{ id: 'annotation-1', source_message_id: 'message-9', text: 'quote', comment: '', start: 0, end: 5 }];
    await api.startTask({ conversation_id: 'conversation-1' }, 'Look at this', attachments, {}, () => {}, undefined, annotations);

    assert.equal(calls[0].path, '/api/messages/images');
    assert.equal(calls[0].init.body.get('conversation_id'), 'conversation-1');
    assert.equal(calls[0].init.body.get('file').type, 'image/png');
    assert.equal(calls[0].init.body.get('file').size, file.size);
    assert.deepEqual(JSON.parse(calls[1].init.body).image_attachments, attachments);
    // 引用批注与图片同属这一轮的请求体（桌面的 buildDeployRequest 与 core 的
    // TaskStreamRequest 都是这么收的）；没带注释时给空数组，而不是把字段省掉。
    assert.deepEqual(JSON.parse(calls[1].init.body).annotations, annotations);
    await api.startTask({ conversation_id: 'conversation-1' }, 'Plain turn', [], {}, () => {});
    assert.deepEqual(JSON.parse(calls[2].init.body).annotations, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('running task input uses the desktop structured attachment protocol and returns its queued event', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_path, init = {}) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ input_id: 'i1', event: { type: 'task_input_queued', payload: { input_id: 'i1' } } }), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await api.sendInput('task-1', 'Inspect this', [{ image_id: 'image-1', path: '/tmp/shot.png' }]);
    assert.deepEqual(requestBody, {
      message: 'Inspect this',
      image_attachments: [{ image_id: 'image-1', path: '/tmp/shot.png', mime: null }],
    });
    assert.equal(response.event.type, 'task_input_queued');
    assert.equal(response.input_id, 'i1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('task reads stay on the runtime view and carry the incremental cursor', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (path) => {
    paths.push(path);
    return new Response(JSON.stringify({ task_id: 'task-1', events: [], events_delta: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await api.task('task-1');
    await api.task('task-1', { afterEventId: 'event 2/3' });
    assert.deepEqual(paths, [
      '/api/tasks/task-1?event_view=runtime',
      '/api/tasks/task-1?event_view=runtime&after_event_id=event%202%2F3',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider models fall back to the runtime built-in catalog when live refresh fails', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push([path, body]);
    if (body.refresh) {
      return new Response(JSON.stringify({ detail: 'Model catalog request failed: 401 Unauthorized' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      provider: 'openai',
      default_model: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }],
      models_source: 'static',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const catalog = await api.providerModels({
      llmConfigId: 'oauth-record',
      provider: 'openai',
      authMode: 'oauth',
      customProvider: '',
      baseUrl: '',
      defaultModelId: 'gpt-5.6-sol',
    });
    assert.deepEqual(calls.map(([, body]) => body.refresh), [true, false]);
    assert.equal(calls[0][0], '/api/llm/models');
    assert.equal(calls[1][1].model, 'gpt-5.6-sol');
    assert.deepEqual(calls.map(([, body]) => body.llm_config_id), ['oauth-record', 'oauth-record']);
    assert.deepEqual(catalog.models.map((item) => item.id), ['gpt-5.5', 'gpt-5.4']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider model fallback does not mask unrelated errors', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: 'runtime unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await assert.rejects(api.providerModels({ provider: 'openai' }), { status: 503 });
    assert.equal(calls, 2); // the error helper also checks /remote/status
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the first message renames the conversation through the core PATCH route', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push([path, init.method, init.body ? JSON.parse(init.body) : null]);
    return new Response(JSON.stringify({ conversation_id: 'abc', title: '修一下键盘' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const renamed = await api.updateConversation('abc', { title: '修一下键盘' });
    assert.deepEqual(calls, [['/api/conversations/abc', 'PATCH', { title: '修一下键盘' }]]);
    assert.equal(renamed.title, '修一下键盘');

    // 会话号里带斜杠这类字符也要转义，路由别被拆成两段。
    await api.updateConversation('a/b', { title: 'x' });
    assert.equal(calls.at(-1)[0], '/api/conversations/a%2Fb');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project directory revalidates with If-None-Match and reuses the cached body on 304', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const directory = { projects: [{ name: 'haish-agent', conversations: [] }] };
  const etag = 'W/"haish-projects-abc123"';
  globalThis.fetch = async (path, init = {}) => {
    calls.push([path, init.headers?.['If-None-Match'] ?? null]);
    if (init.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(JSON.stringify(directory), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: etag },
    });
  };

  try {
    const first = await api.projects();
    assert.deepEqual(first, directory);
    assert.equal(calls[0][1], null, 'first load has no cached ETag');

    const second = await api.projects();
    assert.deepEqual(second, directory, 'a 304 resolves with the previous payload');
    assert.equal(calls[1][1], etag, 'the second request revalidates with If-None-Match');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a changed directory downloads a fresh body and adopts its new ETag', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  // 版本化服务器：If-None-Match 命中当前版本就 304，否则下发当前 body+ETag。
  // 不假设模块缓存的初始状态（上一个测试可能已经留下条目）。
  let current = { etag: 'W/"dir-v1"', body: { projects: [{ name: 'v1', conversations: [] }] } };
  globalThis.fetch = async (_path, init = {}) => {
    const incoming = init.headers?.['If-None-Match'] ?? null;
    calls.push(incoming);
    if (incoming === current.etag) return new Response(null, { status: 304, headers: { ETag: current.etag } });
    return new Response(JSON.stringify(current.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: current.etag },
    });
  };

  try {
    assert.deepEqual(await api.projects(), current.body);
    assert.deepEqual(await api.projects(), current.body, 'unchanged directory short-circuits on 304');
    assert.equal(calls.at(-1), current.etag, 'revalidation carries the adopted ETag');

    current = { etag: 'W/"dir-v2"', body: { projects: [{ name: 'v2', conversations: [] }] } };
    assert.deepEqual(await api.projects(), current.body, 'changed directory downloads v2');
    assert.deepEqual(await api.projects(), current.body, 'the adopted v2 ETag also short-circuits');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retry reuses the task stream contract on the adapter rerun route', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, init });
    return new Response('{"type":"run_started","task_id":"task-2"}\n{"type":"run_finished","task_id":"task-2"}\n', {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };

  try {
    const events = [];
    let opened = false;
    await api.retryTask(
      'conversation-1',
      'task-1',
      { provider: 'chat:custom:router', model_id: 'deepseek-v4-flash', agent_id: 'simple', reasoning_effort: 'low' },
      (event) => events.push(event),
      () => { opened = true; },
    );

    assert.equal(calls[0].path, '/remote/conversations/conversation-1/tasks/task-1/retry');
    assert.equal(calls[0].init.method, 'POST');
    // 运行配置原样交给适配器（它只挑 provider / model / reasoning_effort 发给 runtime）。
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      options: { provider: 'chat:custom:router', model_id: 'deepseek-v4-flash', agent_id: 'simple', reasoning_effort: 'low' },
    });
    assert.equal(opened, true);
    assert.deepEqual(events.map((event) => event.type), ['run_started', 'run_finished']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rejected retry keeps the runtime verdict for the row', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'Only the latest turn can be retried.' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await assert.rejects(api.retryTask('conversation-1', 'task-1', {}, () => {}), {
      message: /Only the latest turn can be retried\./,
      status: 409,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
