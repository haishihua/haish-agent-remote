import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THINKING_OPTIONS,
  agentOptionsFromPayload,
  providerOptionsFromSettings,
  resolveRunConfig,
  taskOptionsForRunConfig,
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

test('official providers use canonical labels instead of stale profile names', () => {
  const providers = providerOptionsFromSettings({
    profiles: [{ provider: 'deepseek', id: 'deepseek', name: 'New LLM', model: 'deepseek-v4-flash' }],
  });

  assert.equal(providers[0].label, 'DeepSeek');
});
