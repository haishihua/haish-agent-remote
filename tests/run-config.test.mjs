import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THINKING_OPTIONS,
  agentOptionsFromPayload,
  mergeProviderModels,
  modelOptionsFromTasks,
  providerOptionsFromSettings,
  resolveRunConfig,
  taskOptionsForRunConfig,
  withCurrentModel,
  loadLastRunConfig,
  saveLastRunConfig,
  CONVERSATION_RUN_CONFIG_STORAGE_KEY,
  forgetRunConfigCache,
  loadConversationRunConfig,
  rememberConversationRunConfig,
} from '../src/run-config.js';

test('a new conversation uses the remembered client configuration instead of the first remote profile', () => {
  const providers = providerOptionsFromSettings({
    profiles: [
      { id: 'openai', provider: 'openai', model: 'gpt-6.1-sol' },
      { id: 'router', provider: 'custom', name: 'ai router', model: 'deepseek-v4-flash' },
    ],
  });
  assert.deepEqual(resolveRunConfig({}, providers, [], {
    providerId: 'router', modelId: 'deepseek-v4-flash', agentId: 'simple', thinking: 'medium',
  }), {
    providerId: 'router', modelId: 'deepseek-v4-flash', agentId: 'simple', thinking: 'medium',
  });
});

test('remembered configuration round-trips through guarded storage', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  saveLastRunConfig({ providerId: 'router', modelId: 'model-a', agentId: 'agent', thinking: 'xhigh' }, storage);
  assert.deepEqual(loadLastRunConfig(storage), { providerId: 'router', modelId: 'model-a', agentId: 'agent', thinking: 'xhigh' });
});
test('runtime config uses the configured provider selector and conversation agent', () => {
  assert.deepEqual(THINKING_OPTIONS.map((item) => item.id), ['low', 'medium', 'high', 'xhigh']);
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'router', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' },
  });
  const agents = agentOptionsFromPayload({ agents: [{ agent_id: 'custom.code', display_name: 'Code Agent' }] });
  const config = resolveRunConfig({ agent_id: 'custom.code' }, providers, agents);

  assert.deepEqual(config, {
    agentId: 'custom.code',
    providerId: 'chat:custom:router',
    modelId: 'gpt-5.6-sol',
    thinking: 'xhigh',
  });
  assert.deepEqual(taskOptionsForRunConfig(config, providers), {
    provider: 'custom:router',
    model_id: 'gpt-5.6-sol',
    agent_id: 'custom.code',
    reasoning_effort: 'xhigh',
  });
});

test('an existing conversation keeps its backend agent and backend LLM defaults', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
    profiles: [{ provider: 'openai', id: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' }],
  });
  const agents = agentOptionsFromPayload({ agents: [
    { agent_id: 'simple', display_name: 'Simple Agent' },
    { agent_id: 'code', display_name: 'Code Agent' },
  ] });

  assert.deepEqual(resolveRunConfig({ agent_id: 'simple' }, providers, agents), {
    agentId: 'simple',
    providerId: 'chat:custom:opencode_go',
    modelId: 'deepseek-v4-flash',
    thinking: 'high',
  });
});

test('an existing conversation inherits the provider and model used by its latest client task', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
    profiles: [
      { id: 'openai', provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' },
      { id: 'router', provider: 'custom', name: 'ai router', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
    ],
  });
  const conversation = {
    last_task_id: 'task-2',
    tasks: [
      { task_id: 'task-1', provider_key: 'openai', model: 'gpt-5.6-sol', agent_id: 'code' },
      { task_id: 'task-2', provider_key: 'custom', model: 'gpt-5.6-sol', agent_id: 'simple' },
    ],
  };

  assert.deepEqual(resolveRunConfig(conversation, providers, []), {
    agentId: 'simple',
    providerId: 'router',
    modelId: 'gpt-5.6-sol',
    thinking: 'medium',
  });
});

test('the provider the client recorded on the task beats the first provider sharing its key and model', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
    profiles: [
      { id: 'llm-profile-router', provider: 'custom', name: 'ai rounter', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
      { id: 'llm-profile-code', provider: 'custom', name: 'command code', model: 'deepseek/deepseek-v4.1-flash', reasoning_effort: 'high' },
    ],
  });
  const conversation = {
    last_task_id: 'task-1',
    tasks: [{
      task_id: 'task-1',
      provider_key: 'custom',
      provider: 'Custom',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'xhigh',
      request_options: { provider: 'llm-profile-router', model_id: 'deepseek-v4-flash', reasoning_effort: 'xhigh' },
    }],
  };

  assert.deepEqual(resolveRunConfig(conversation, providers, []), {
    agentId: '',
    providerId: 'llm-profile-router',
    modelId: 'deepseek-v4-flash',
    thinking: 'xhigh',
  });
});

test('the runtime field request_provider restores the provider the conversation ran with', () => {
  // The live 「后端优化」 shape: the chat entry and two saved profiles all answer to the
  // generic `custom` key, and two of them serve the same model, so the selector the
  // client recorded is the only value that says which one the task actually ran with.
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
    profiles: [
      { id: 'llm-profile-1783479743079', provider: 'custom', name: 'ai rounter', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
      { id: 'llm-profile-command-code', provider: 'custom', name: 'command code', model: 'deepseek/deepseek-v4.1-flash', reasoning_effort: 'high' },
    ],
  });
  const conversation = {
    last_task_id: '5b2b80a2118b47508f84e3e916c5a9be',
    tasks: [{
      task_id: '5b2b80a2118b47508f84e3e916c5a9be',
      provider: 'Custom',
      provider_key: 'custom',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'xhigh',
      request_provider: 'llm-profile-1783479743079',
      request_model_id: 'deepseek-v4-flash',
    }],
  };

  assert.deepEqual(resolveRunConfig(conversation, providers, []), {
    agentId: '',
    providerId: 'llm-profile-1783479743079',
    modelId: 'deepseek-v4-flash',
    thinking: 'xhigh',
  });
});

test('the adapter can hand the recorded selector over as a flat field', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash' },
    profiles: [{ id: 'llm-profile-router', provider: 'custom', name: 'ai rounter', model: 'deepseek-v4-flash' }],
  });

  assert.equal(
    resolveRunConfig({ tasks: [{ task_id: 't', provider_key: 'custom', model: 'deepseek-v4-flash', requested_provider: 'llm-profile-router' }] }, providers, []).providerId,
    'llm-profile-router',
  );
  assert.equal(
    resolveRunConfig({ tasks: [{ task_id: 't', provider_key: 'custom', model: 'deepseek-v4-flash', requested_provider: 'custom:opencode_go' }] }, providers, []).providerId,
    'chat:custom:opencode_go',
  );
});

test('a recorded selector that no longer exists falls back to key and model matching', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash' },
    profiles: [{ id: 'llm-profile-router', provider: 'custom', name: 'ai rounter', model: 'deepseek-v4-flash' }],
  });

  assert.deepEqual(resolveRunConfig({
    tasks: [{ task_id: 't', provider_key: 'custom', model: 'deepseek-v4-flash', request_options: { provider: 'llm-profile-deleted' } }],
  }, providers, []), {
    agentId: '',
    providerId: 'chat:custom:opencode_go',
    modelId: 'deepseek-v4-flash',
    thinking: 'high',
  });
});

test('an older recorded task is used when the newest task carries no selector', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash' },
    profiles: [{ id: 'llm-profile-router', provider: 'custom', name: 'ai rounter', model: 'deepseek-v4-flash' }],
  });
  const conversation = {
    last_task_id: 'task-2',
    tasks: [
      { task_id: 'task-1', provider_key: 'custom', model: 'deepseek-v4-flash', request_options: { provider: 'llm-profile-router' } },
      { task_id: 'task-2', provider_key: 'custom', model: 'deepseek-v4-flash' },
    ],
  };

  assert.deepEqual(resolveRunConfig(conversation, providers, []), {
    agentId: '',
    providerId: 'llm-profile-router',
    modelId: 'deepseek-v4-flash',
    thinking: 'high',
  });
});

test('prefixed backend model ids restore the matching provider and thinking level', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'router-a', model: 'gpt-5.6-sol', reasoning_effort: 'low' },
    profiles: [{ id: 'router-b', provider: 'custom', name: 'router-b', model: 'other-model', reasoning_effort: 'xhigh' }],
  });

  assert.deepEqual(resolveRunConfig({
    last_task_id: 'task-1',
    tasks: [{ task_id: 'task-1', provider_key: 'custom', model: 'vendor/gpt-5.6-sol', reasoning_effort: 'medium' }],
  }, providers, []), {
    agentId: '',
    providerId: 'chat:custom:router-a',
    modelId: 'vendor/gpt-5.6-sol',
    thinking: 'medium',
  });
});

test('profiles that share a provider key are told apart by the model the task ran with', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'router-a', model: 'model-a', reasoning_effort: 'low' },
    profiles: [{ id: 'router-b', provider: 'custom', name: 'router-b', model: 'model-b', reasoning_effort: 'xhigh' }],
  });

  assert.deepEqual(resolveRunConfig({
    last_task_id: 'task-1',
    tasks: [{ task_id: 'task-1', provider_key: 'custom', provider: 'Custom', model: 'model-b' }],
  }, providers, []), {
    agentId: '',
    providerId: 'router-b',
    modelId: 'model-b',
    thinking: 'xhigh',
  });
});

test('the client model catalog keeps configured and previously used models when refresh falls back', () => {
  const settings = {
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash' },
    profiles: [{ id: 'llm-profile-openai-oauth', provider: 'openai', auth_mode: 'oauth', model: 'gpt-5.6-sol' }],
  };
  const provider = providerOptionsFromSettings(settings)[1];
  const tasks = [
    { provider_key: 'openai', provider: 'OpenAI', model: 'gpt-6-astra' },
    { request_provider: 'llm-profile-openai-oauth', provider_key: 'openai', model: 'gpt-5.6-sol' },
    { request_provider: 'another-profile', provider_key: 'openai', model: 'not-this-profile' },
  ];
  const taskModels = modelOptionsFromTasks(provider, tasks);
  const merged = mergeProviderModels(provider, {
    models: [{ id: 'gpt-5.5', label: 'gpt5.5' }, { id: 'gpt-5.4', label: 'gpt5.4' }],
    models_source: 'static',
  }, taskModels);

  assert.deepEqual(merged.map((item) => item.id), ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-6-astra']);
});

test('a model the runtime list does not know stays selectable', () => {
  const models = [{ id: 'model-a', label: 'Model A' }];
  assert.deepEqual(withCurrentModel(models, 'vendor/model-a'), [{ id: 'vendor/model-a', label: 'vendor/model-a' }, ...models]);
  assert.deepEqual(withCurrentModel(models, 'model-a'), models);
  assert.deepEqual(withCurrentModel(models, ''), models);
});

test('official providers use canonical labels instead of stale profile names', () => {
  const providers = providerOptionsFromSettings({
    profiles: [{ provider: 'deepseek', id: 'deepseek', name: 'New LLM', model: 'deepseek-v4-flash' }],
  });

  assert.equal(providers[0].label, 'DeepSeek');
});

// 手机端自己的会话级缓存（用户：「我在手机上改变了运行配置…应该要有缓存呀，而不是我每次都换」）。
// 排列顺序是硬契约：手机选的 provider/model/thinking > 任务记录那套 > 客户端上次的配置。
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('the phone remembers the run config it picked for a conversation', () => {
  const storage = memoryStorage();
  rememberConversationRunConfig('conv-1', {
    providerId: 'router', modelId: 'deepseek-v4-flash', agentId: 'code', thinking: 'low',
  }, storage);

  assert.deepEqual(loadConversationRunConfig('conv-1', storage), {
    providerId: 'router', modelId: 'deepseek-v4-flash', agentId: 'code', thinking: 'low',
  });
  assert.equal(loadConversationRunConfig('conv-2', storage), null);
  assert.equal(loadConversationRunConfig('', storage), null);
});

test('the conversation cache beats the provider recorded on the latest task', () => {
  const providers = providerOptionsFromSettings({
    chat: { provider: 'custom', name: 'opencode_go', model: 'deepseek-v4-flash', reasoning_effort: 'high' },
    profiles: [
      { id: 'openai', provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' },
      { id: 'router', provider: 'custom', name: 'ai router', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
    ],
  });
  const conversation = {
    last_task_id: 'task-2',
    tasks: [{ task_id: 'task-2', provider_key: 'openai', model: 'gpt-5.6-sol', agent_id: 'simple', reasoning_effort: 'xhigh' }],
  };

  // 没有缓存时沿用任务记录（桌面跑出来的那套）。
  assert.equal(resolveRunConfig(conversation, providers, []).providerId, 'openai');
  // 手机在这个会话里换成了 router + 别的 thinking：重开必须还是它。
  assert.deepEqual(resolveRunConfig(conversation, providers, [], null, {
    providerId: 'router', modelId: 'deepseek-v4-flash', thinking: 'low',
  }), {
    agentId: 'simple', providerId: 'router', modelId: 'deepseek-v4-flash', thinking: 'low',
  });
});

test('a cached provider the runtime no longer offers falls back to the recorded task', () => {
  const providers = providerOptionsFromSettings({
    profiles: [{ id: 'openai', provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' }],
  });
  const conversation = { tasks: [{ task_id: 'task-1', provider_key: 'openai', model: 'gpt-5.6-sol' }] };

  assert.deepEqual(resolveRunConfig(conversation, providers, [], null, {
    providerId: 'deleted-profile', modelId: 'gone', thinking: 'low',
  }), {
    agentId: '', providerId: 'openai', modelId: 'gpt-5.6-sol', thinking: 'xhigh',
  });
});

test('the cache is bounded and forgets the least recently written conversation', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 205; index += 1) {
    rememberConversationRunConfig(`conv-${index}`, { providerId: 'router', modelId: 'model', thinking: 'high' }, storage);
  }
  const stored = JSON.parse(storage.values.get(CONVERSATION_RUN_CONFIG_STORAGE_KEY));
  assert.equal(Object.keys(stored).length, 200);
  assert.equal(stored['conv-0'], undefined);
  assert.ok(stored['conv-204']);
});

test('logout clears the conversation cache and unreadable storage is tolerated', () => {
  const storage = memoryStorage();
  rememberConversationRunConfig('conv-1', { providerId: 'router', thinking: 'high' }, storage);
  forgetRunConfigCache(storage);
  assert.equal(loadConversationRunConfig('conv-1', storage), null);

  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } };
  assert.equal(loadConversationRunConfig('conv-1', broken), null);
  assert.equal(loadLastRunConfig(broken), null);
  rememberConversationRunConfig('conv-1', { providerId: 'router' }, broken);
  forgetRunConfigCache(broken);
});

test('a cached model the catalog no longer lists is kept instead of being swapped', () => {
  // 模型目录是「配置里那个 + 这个 provider 用过的」合并出来的（见 `withCurrentModel`）：
  // 目录里没有不代表 runtime 不认。这时猜一个默认值，等于又把用户刚选的模型默默换掉——
  // 正是这次要修的那个抱怨。
  const providers = providerOptionsFromSettings({
    profiles: [{ id: 'router', provider: 'custom', name: 'ai router', model: 'gpt-5.6-sol', reasoning_effort: 'medium' }],
  });
  const conversation = { last_task_id: 'task-1', tasks: [{ task_id: 'task-1', provider_key: 'custom', model: 'gpt-5.6-sol' }] };

  assert.deepEqual(resolveRunConfig(conversation, providers, [], null, {
    providerId: 'router', modelId: 'not-in-catalog', thinking: 'low',
  }), {
    agentId: '', providerId: 'router', modelId: 'not-in-catalog', thinking: 'low',
  });
});
