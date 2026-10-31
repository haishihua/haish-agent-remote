import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { api } from '../src/api.js';
import { providerOptionsFromSettings, resolveRunConfig, modelOptionsFromTasks, runConfigForSend, taskOptionsForRunConfig } from '../src/run-config.js';

const settings = {
  profiles: [
    { id: 'api-record', provider: 'openai', auth_mode: 'api_key', model: 'gpt-6.1-terra', reasoning_effort: 'high' },
    { id: 'oauth-record', provider: 'openai', auth_mode: 'oauth', model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' },
  ],
};
const providers = providerOptionsFromSettings(settings);
const task = {
  task_id: 'oauth-task', request_llm_config_id: 'oauth-record',
  provider_key: 'openai', model: 'gpt-6.1-terra', agent_id: 'agent', reasoning_effort: 'xhigh',
};
const conversation = { conversation_id: 'conversation', last_task_id: 'oauth-task', tasks: [task] };

test('modern OAuth identity beats a same-provider API model match, catalog order and stale phone cache', () => {
  for (const catalog of [providers, [...providers].reverse()]) {
    for (const cache of [null, { providerId: 'api-record', modelId: 'gpt-6.1-terra', thinking: 'high' }]) {
      assert.deepEqual(resolveRunConfig(conversation, catalog, [], null, cache), {
        providerId: 'oauth-record', modelId: 'gpt-6.1-terra', agentId: 'agent', thinking: 'xhigh',
      });
    }
  }
});

test('identical provider and default model still cannot merge API and OAuth records', () => {
  const catalog = providerOptionsFromSettings({ profiles: settings.profiles.map((profile) => ({ ...profile, model: 'same-model' })) });
  const config = resolveRunConfig({ tasks: [{ ...task, model: 'same-model' }] }, catalog, [], null, { providerId: 'api-record', modelId: 'same-model' });
  assert.equal(config.providerId, 'oauth-record');
  assert.equal(taskOptionsForRunConfig(config, catalog).llm_config_id, 'oauth-record');
});

test('nested modern IDs beat conflicting legacy aliases and older recorded tasks', () => {
  const config = resolveRunConfig({ tasks: [
    { ...task, request_llm_config_id: 'api-record' },
    { ...task, task_id: 'latest', request_llm_config_id: undefined, request_provider: 'api-record', request_options: { llm_config_id: 'oauth-record' } },
  ], last_task_id: 'latest' }, providers, []);
  assert.equal(config.providerId, 'oauth-record');
});

test('saved current route wins over historical task and stale cache without losing model or effort', () => {
  const result = resolveRunConfig({
    ...conversation,
    tasks: [{ ...task, request_llm_config_id: 'api-record' }],
    run_config: { llm_config_id: 'oauth-record', model_id: 'another-model', reasoning_effort: 'low' },
  }, providers, [], null, { providerId: 'api-record', modelId: 'gpt-6.1-terra' });
  assert.deepEqual(result, { providerId: 'oauth-record', modelId: 'another-model', agentId: 'agent', thinking: 'low' });
});

test('an incomplete saved current route cannot borrow an old identity or model', () => {
  for (const saved of [{}, { llm_config_id: null, model_id: 'gpt-6.1-terra' }, { llm_config_id: 'oauth-record', model_id: null }, { llm_config_id: 'removed', model_id: 'same-model' }]) {
    const config = resolveRunConfig({ ...conversation, run_config: saved }, providers, [], null, { providerId: 'api-record', modelId: 'old' });
    assert.throws(() => taskOptionsForRunConfig(config, providers), /unavailable/);
  }
});

test('an unavailable recorded identity is retained and blocks sends instead of choosing API', () => {
  const config = resolveRunConfig(conversation, providers.filter((p) => p.id !== 'oauth-record'), []);
  assert.equal(config.providerId, 'oauth-record');
  assert.throws(() => taskOptionsForRunConfig(config, providers.filter((p) => p.id !== 'oauth-record')), /unavailable.*Reselect/);
  assert.throws(() => taskOptionsForRunConfig(null, providers), /unavailable/);
});

test('OAuth and API model history stays isolated by modern identity', () => {
  const tasks = [task, { ...task, request_llm_config_id: 'api-record', model: 'api-only' }];
  assert.deepEqual(modelOptionsFromTasks(providers[1], tasks).map((m) => m.id), ['gpt-6.1-terra']);
  assert.deepEqual(modelOptionsFromTasks(providers[0], tasks).map((m) => m.id), ['api-only']);
});

test('the picker distinguishes OAuth from API Key without changing the configuration identity', () => {
  assert.deepEqual(providers.map((p) => p.label), ['OpenAI · API Key', 'OpenAI · OAuth']);
  assert.deepEqual(providers.map((p) => p.llmConfigId), ['api-record', 'oauth-record']);
});

test('production restore -> start and retry serialize the OAuth ID, not a provider/model guess', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (path, init) => {
    requests.push({ path, body: JSON.parse(init.body) });
    return new Response('{"type":"run_started","task_id":"new-task"}\n', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };
  try {
    const config = resolveRunConfig(conversation, providers, []);
    const options = taskOptionsForRunConfig(config, providers);
    await api.startTask(conversation, 'test only', [], options, () => {});
    await api.retryTask('conversation', 'oauth-task', options, () => {});
    for (const { body } of requests) {
      assert.equal(body.options.llm_config_id, 'oauth-record');
      assert.equal(body.options.model_id, 'gpt-6.1-terra');
      assert.equal(body.options.provider, undefined);
    }
    // A deliberate API choice is still allowed; this is not an OAuth-only override.
    assert.equal(taskOptionsForRunConfig({ ...config, providerId: 'api-record' }, providers).llm_config_id, 'api-record');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an exact legacy record ID also beats stale cache without guessing from the model', () => {
  const legacy = { ...conversation, tasks: [{ ...task, request_llm_config_id: undefined, requested_provider: 'oauth-record' }] };
  assert.equal(resolveRunConfig(legacy, providers, [], null, { providerId: 'api-record', modelId: 'gpt-6.1-terra' }).providerId, 'oauth-record');
});

test('send-time route read replaces stale restored state, but never a deliberate choice', async () => {
  let selection = { config: { providerId: 'api-record', modelId: 'old' }, explicit: false };
  const args = {
    conversation, providers, agents: [], getSelection: () => selection,
    rememberedConfig: selection.config,
    loadSavedConfig: async () => ({ llm_config_id: 'oauth-record', model_id: 'new-current', reasoning_effort: 'medium' }),
  };
  assert.deepEqual(await runConfigForSend(args), { providerId: 'oauth-record', modelId: 'new-current', thinking: 'medium', agentId: 'agent' });
  selection = { config: { providerId: 'api-record', modelId: 'chosen' }, explicit: true };
  assert.equal(await runConfigForSend({ ...args, loadSavedConfig: () => { throw new Error('must not refresh explicit intent'); } }), selection.config);
});

test('a picker change during the current-route read is not overwritten', async () => {
  let selection = { config: null, explicit: false };
  let finish;
  const pending = runConfigForSend({
    conversation, providers, agents: [], getSelection: () => selection,
    loadSavedConfig: () => new Promise((resolve) => { finish = resolve; }),
  });
  selection = { config: { providerId: 'api-record', modelId: 'chosen' }, explicit: true };
  finish({ llm_config_id: 'oauth-record', model_id: 'server' });
  assert.equal(await pending, selection.config);
});

test('failed authoritative route reads block rather than reusing a stale cache', async () => {
  await assert.rejects(runConfigForSend({
    conversation, providers, agents: [],
    getSelection: () => ({ config: { providerId: 'api-record' }, explicit: false }),
    loadSavedConfig: async () => { throw new Error('offline'); },
  }), /offline/);
});

test('App waits for the current server route and validates selection before clearing a draft', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /Promise\.all\(\[api\.agents\(\), api\.llmSettings\(\), api\.conversationRunConfig\(id\)\]\)/);
  assert.match(source, /persistedRunConfig === undefined/);
  const submit = source.slice(source.indexOf('async function submit(event)', source.indexOf('function ConversationDetail')));
  assert.ok(submit.indexOf('runOptions = await prepareRunConfig()') > 0);
  assert.ok(submit.indexOf('runOptions = await prepareRunConfig()') < submit.indexOf('composerImagesRef.current = []'));
  const retry = source.slice(source.indexOf('const retryFailedRun'), source.indexOf('const retryRef'));
  assert.match(retry, /const runOptions = await prepareRunConfig\(\)/);
  assert.match(source, /runConfigExplicitRef\.current = true/);
  assert.match(source, /runConfigExplicitRef\.current = false/);
});
