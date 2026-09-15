import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THINKING_OPTIONS,
  agentOptionsFromPayload,
  providerOptionsFromSettings,
  resolveRunConfig,
  taskOptionsForRunConfig,
  withCurrentModel,
} from '../src/run-config.js';

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
