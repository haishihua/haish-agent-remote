const PROVIDER_LABELS = {
  openai: 'OpenAI',
  xai: 'xAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  dashscope: 'DashScope',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  zhipu: 'Zhipu',
  ollama: 'Ollama',
  custom: 'Custom',
};

export const THINKING_OPTIONS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
];

function uniqueModels(...groups) {
  const seen = new Set();
  return groups.flat().map((item) => {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim();
    if (!id || seen.has(id)) return null;
    seen.add(id);
    return { id, label: String(typeof item === 'string' ? item : item?.label || id).trim() || id };
  }).filter(Boolean);
}

function providerSelector(config) {
  const provider = String(config?.provider || '').trim().toLowerCase().replaceAll('-', '_');
  if (provider !== 'custom') return provider || 'auto';
  const name = String(config?.name || config?.custom_provider || config?.base_url || config?.model || '').trim();
  return name ? `custom:${name}` : 'custom';
}

export function providerOptionsFromSettings(settings) {
  return [settings?.chat, ...(Array.isArray(settings?.profiles) ? settings.profiles : [])]
    .filter((config) => config?.provider)
    .map((config, index) => {
      const provider = String(config.provider).trim().toLowerCase().replaceAll('-', '_');
      const selector = providerSelector(config);
      const id = String(config.id || (index === 0 ? `chat:${selector}` : `profile:${selector}:${index}`));
      const customName = String(config.name || config.custom_provider || '').trim();
      const defaultModelId = String(config.model || '').trim();
      return {
        id,
        label: provider === 'custom'
          ? (customName || PROVIDER_LABELS.custom)
          : (PROVIDER_LABELS[provider] || provider),
        provider,
        requestProvider: String(config.id || selector),
        authMode: String(config.auth_mode || '').trim(),
        customProvider: provider === 'custom' ? customName : '',
        baseUrl: provider === 'custom' ? String(config.base_url || '').trim() : '',
        defaultModelId,
        reasoningEffort: String(config.reasoning_effort || 'high'),
        models: uniqueModels(defaultModelId, config.model_options || []),
      };
    });
}

export function modelOptionsFromTasks(provider, tasks) {
  const rows = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  const selector = String(provider?.requestProvider || '').trim();
  const providerKey = String(provider?.provider || '').trim();
  const customProvider = String(provider?.customProvider || '').trim();
  const matches = rows.filter((task) => {
    const requestProvider = taskProviderSelector(task);
    if (selector && requestProvider === selector) return true;
    if (requestProvider) return false;
    const taskProvider = String(task?.provider_key || task?.provider || '').trim();
    return providerKeyMatches(provider, taskProvider)
      || (customProvider && normalizedProviderKey(customProvider) === normalizedProviderKey(taskProvider));
  });
  return uniqueModels(matches.map((task) => task?.request_model_id || task?.model || taskRequestOptions(task)?.model_id || ''));
}

export function mergeProviderModels(provider, catalog, taskModels = [], currentModelId = '') {
  return uniqueModels(
    currentModelId,
    provider?.defaultModelId,
    catalog?.models || [],
    provider?.models || [],
    taskModels,
  );
}

export function settingsWithProviderModel(settings, providerId, modelId) {
  const id = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  if (!settings || typeof settings !== 'object' || !id || !model) return null;
  const providers = providerOptionsFromSettings(settings);
  const providerIndex = providers.findIndex((item) => item.id === id);
  if (providerIndex < 0) return null;
  const next = {
    ...settings,
    chat: settings.chat && typeof settings.chat === 'object' ? { ...settings.chat } : {},
    profiles: Array.isArray(settings.profiles) ? settings.profiles.map((profile) => ({ ...profile })) : [],
  };
  if (providerIndex === 0 && settings.chat?.provider) next.chat.model = model;
  else {
    const profileIndex = providerIndex - (settings.chat?.provider ? 1 : 0);
    if (!next.profiles[profileIndex]) return null;
    next.profiles[profileIndex].model = model;
  }
  return next;
}

export function agentOptionsFromPayload(payload) {
  return (Array.isArray(payload) ? payload : payload?.agents || []).map((item) => ({
    id: String(item?.agent_id || item?.id || item?.profile_id || '').trim(),
    label: String(item?.display_name || item?.label || item?.agent_id || item?.id || '').trim(),
  })).filter((item) => item.id);
}

function normalizedModel(value) {
  return String(value || '').trim().toLowerCase();
}

function modelMatches(provider, modelId) {
  const target = normalizedModel(modelId);
  if (!target) return false;
  const candidates = [provider?.defaultModelId, ...(provider?.models || []).map((item) => item.id)]
    .map(normalizedModel)
    .filter(Boolean);
  return candidates.some((candidate) => candidate === target
    || candidate.endsWith(`/${target}`)
    || target.endsWith(`/${candidate}`));
}

function normalizedProviderKey(value) {
  return String(value || '').trim().toLowerCase().replaceAll('-', '_');
}

function providerKeyMatches(provider, key) {
  const target = normalizedProviderKey(key);
  if (!target) return false;
  return [provider?.id, provider?.requestProvider, provider?.provider, provider?.customProvider]
    .some((value) => normalizedProviderKey(value) === target);
}

function taskRequestOptions(task) {
  const options = task?.request_options;
  return options && typeof options === 'object' ? options : null;
}

// The raw selector the client sent with the task, e.g. `llm-profile-1783479743079`
// for a saved provider entry or `custom:opencode_go` for the chat-level provider.
// The runtime records it per task as `request_options.provider` and hands it back as
// the flat `request_provider`; older runtimes leave the adapter to provide
// `requested_provider` from the state the runtime keeps on disk.
function taskProviderSelector(task) {
  const options = taskRequestOptions(task);
  return String(task?.request_provider || task?.requested_provider || task?.provider_selector || options?.provider || '').trim();
}

function providerSelectorMatches(provider, selector) {
  const target = String(selector || '').trim().toLowerCase();
  if (!target) return false;
  const ids = [provider?.id, provider?.requestProvider]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (ids.includes(target)) return true;
  const separator = target.indexOf(':');
  const key = separator === -1 ? target : target.slice(0, separator);
  const customName = separator === -1 ? '' : target.slice(separator + 1).trim();
  if (!providerKeyMatches(provider, key)) return false;
  if (!customName) return true;
  return normalizedProviderKey(provider?.customProvider) === normalizedProviderKey(customName);
}

// Saved custom providers share the generic `custom` key and can even share the same
// model, so `provider_key` + `model` cannot tell two of them apart. The recorded
// client selector is the only value that identifies the entry the conversation
// actually ran with; when the client sent a bare key such as `custom`, the model is
// still the better tie-breaker.
function providerFromSelector(providers, selector, taskModel) {
  if (!selector) return null;
  const matches = providers.filter((item) => providerSelectorMatches(item, selector));
  if (matches.length === 0) return null;
  return matches.find((item) => modelMatches(item, taskModel)) || matches[0];
}

// `provider_key`, `model` and `reasoning_effort` live on the task (the runtime
// stores nothing of the sort on the conversation), so the latest task that recorded
// how it ran is the only record of what the conversation was configured with.
export function resolveRunConfig(conversation, providers, agents) {
  const tasks = Array.isArray(conversation?.tasks) ? conversation.tasks : [];
  const latestTask = tasks.find((task) => task?.task_id === conversation?.last_task_id) || tasks.at(-1) || null;
  const recordedTask = taskProviderSelector(latestTask)
    ? latestTask
    : [...tasks].reverse().find((task) => taskProviderSelector(task)) || latestTask;
  const taskOptions = taskRequestOptions(recordedTask);
  const taskProvider = recordedTask?.provider_key || recordedTask?.provider || '';
  const taskModel = recordedTask?.model || taskOptions?.model_id || recordedTask?.request_model_id || '';
  const provider = providerFromSelector(providers, taskProviderSelector(recordedTask), taskModel)
    || providers.find((item) => providerKeyMatches(item, taskProvider) && modelMatches(item, taskModel))
    || providers.find((item) => modelMatches(item, taskModel))
    || providers.find((item) => providerKeyMatches(item, taskProvider))
    || providers[0] || null;
  const conversationAgentId = String(recordedTask?.agent_id || recordedTask?.profile_id || conversation?.agent_id || conversation?.profile_id || '').trim();
  const agentId = conversationAgentId || agents[0]?.id || '';
  const thinking = [recordedTask?.reasoning_effort, taskOptions?.reasoning_effort, provider?.reasoningEffort]
    .find((value) => THINKING_OPTIONS.some((item) => item.id === value)) || 'high';
  const modelId = String(taskModel || provider?.defaultModelId || provider?.models[0]?.id || '').trim();
  return { agentId, providerId: provider?.id || '', modelId, thinking };
}

// The provider model list is fetched from the runtime and can lag behind the model
// a task actually ran with (the runtime stores provider-prefixed ids such as
// `vendor/model`), so keep the current selection in the list instead of letting it
// silently fall back to another model.
export function withCurrentModel(models, modelId) {
  const list = Array.isArray(models) ? models : [];
  const id = String(modelId || '').trim();
  if (!id || list.some((item) => item.id === id)) return list;
  return [{ id, label: id }, ...list];
}

export function taskOptionsForRunConfig(config, providers) {
  const provider = providers.find((item) => item.id === config?.providerId);
  return {
    provider: provider?.requestProvider || null,
    model_id: config?.modelId || null,
    agent_id: config?.agentId || null,
    reasoning_effort: config?.thinking || 'high',
  };
}
