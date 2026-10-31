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

export const LAST_RUN_CONFIG_STORAGE_KEY = 'haish_remote_last_run_config_v1';

// Legacy runtimes without a saved configuration identity can use this phone's
// cache. A server run_config or recorded configuration ID is authoritative: an
// old inferred API selection must never replace an OAuth record on reopen.
export const CONVERSATION_RUN_CONFIG_STORAGE_KEY = 'haish_remote_conversation_run_config_v1';
// 会话 id 是 runtime 侧生成的字符串，每台手机都可能有上千条历史；留最近用过的这些就够，
// 超出的按最后写入时间淘汰（localStorage 是同步的，不能让它无限长）。
const CONVERSATION_RUN_CONFIG_LIMIT = 200;

function normalizedRunConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const providerId = String(value.providerId || '').trim();
  if (!providerId) return null;
  return {
    providerId,
    modelId: String(value.modelId || '').trim(),
    agentId: String(value.agentId || '').trim(),
    thinking: THINKING_OPTIONS.some((item) => item.id === value.thinking) ? value.thinking : 'high',
  };
}

export function loadLastRunConfig(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LAST_RUN_CONFIG_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return null;
    return {
      providerId: String(value.providerId || '').trim(),
      modelId: String(value.modelId || '').trim(),
      agentId: String(value.agentId || '').trim(),
      thinking: THINKING_OPTIONS.some((item) => item.id === value.thinking) ? value.thinking : 'high',
    };
  } catch {
    return null;
  }
}

export function saveLastRunConfig(config, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LAST_RUN_CONFIG_STORAGE_KEY, JSON.stringify({
      providerId: String(config?.providerId || '').trim(),
      modelId: String(config?.modelId || '').trim(),
      agentId: String(config?.agentId || '').trim(),
      thinking: THINKING_OPTIONS.some((item) => item.id === config?.thinking) ? config.thinking : 'high',
    }));
  } catch {
    // WebView storage can be unavailable; run configuration still works in memory.
  }
}

function readConversationRunConfigs(storage) {
  try {
    const raw = storage?.getItem(CONVERSATION_RUN_CONFIG_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** 这台手机在这个会话里最后选定的运行配置；没选过就是 `null`。 */
export function loadConversationRunConfig(conversationId, storage = globalThis.localStorage) {
  const key = String(conversationId || '').trim();
  if (!key) return null;
  const entry = readConversationRunConfigs(storage)[key];
  return normalizedRunConfig(entry);
}

/** 记下这个会话的配置。写坏了也不影响本轮运行（内存里那份照旧）。 */
export function rememberConversationRunConfig(conversationId, config, storage = globalThis.localStorage) {
  const key = String(conversationId || '').trim();
  const value = normalizedRunConfig(config);
  if (!key || !value) return;
  try {
    const entries = readConversationRunConfigs(storage);
    entries[key] = { ...value, at: Date.now() };
    const keys = Object.keys(entries);
    if (keys.length > CONVERSATION_RUN_CONFIG_LIMIT) {
      keys
        .sort((left, right) => Number(entries[left]?.at || 0) - Number(entries[right]?.at || 0))
        .slice(0, keys.length - CONVERSATION_RUN_CONFIG_LIMIT)
        .forEach((staleKey) => { delete entries[staleKey]; });
    }
    storage?.setItem(CONVERSATION_RUN_CONFIG_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // WebView storage can be unavailable; run configuration still works in memory.
  }
}

/** 换一台电脑配对（登出）时整份丢掉：会话 id 是上一台机器的。 */
export function forgetRunConfigCache(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(CONVERSATION_RUN_CONFIG_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

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
      const authMode = String(config.auth_mode || '').trim();
      const authLabel = authMode === 'oauth' || authMode === 'oauth_token' ? 'OAuth'
        : authMode === 'api_key' ? 'API Key' : '';
      const label = provider === 'custom' ? (customName || PROVIDER_LABELS.custom) : (PROVIDER_LABELS[provider] || provider);
      return {
        id,
        label: authLabel ? `${label} · ${authLabel}` : label,
        provider,
        requestProvider: String(config.id || selector),
        llmConfigId: String(config.id || '').trim(),
        authMode,
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

function taskConfigId(task) {
  return String(task?.request_llm_config_id || taskRequestOptions(task)?.llm_config_id || '').trim();
}

// Modern record IDs take precedence over every legacy provider alias. Provider
// keys and models identify capabilities, not an OAuth/API credential record.
function taskProviderSelector(task) {
  const options = taskRequestOptions(task);
  return taskConfigId(task)
    || String(task?.request_provider || task?.requested_provider || task?.provider_selector || options?.provider || '').trim();
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

// Prefer the persisted current route, then the exact identity on the latest task.
// Provider/model inference and the phone cache are legacy-only recovery paths.
export function resolveRunConfig(conversation, providers, agents, lastRunConfig = null, rememberedConfig = null) {
  const tasks = Array.isArray(conversation?.tasks) ? conversation.tasks : [];
  const latestTask = tasks.find((task) => task?.task_id === conversation?.last_task_id) || tasks.at(-1) || null;
  const recordedTask = taskProviderSelector(latestTask)
    ? latestTask
    : [...tasks].reverse().find((task) => taskProviderSelector(task)) || latestTask;
  const taskOptions = taskRequestOptions(recordedTask);
  const saved = conversation?.run_config;
  const savedSelector = String(saved?.llm_config_id || saved?.provider || '').trim();
  const selector = taskProviderSelector(recordedTask);
  const legacyRecord = providers.find((item) => item.llmConfigId && (item.id === selector || item.requestProvider === selector));
  const hasSavedConfig = saved && typeof saved === 'object';
  const exactId = hasSavedConfig ? savedSelector : taskConfigId(recordedTask) || legacyRecord?.id;
  if (hasSavedConfig || exactId) {
    const exactProvider = providers.find((item) => item.id === exactId || item.requestProvider === exactId);
    return {
      agentId: String(conversation?.agent_id || conversation?.profile_id || recordedTask?.agent_id || recordedTask?.profile_id || saved?.agent_id || agents[0]?.id || '').trim(),
      // Keep a deleted/unavailable ID visible. Serialization blocks it instead of
      // silently substituting an available record with different credentials.
      providerId: exactProvider?.id || exactId || '',
      modelId: hasSavedConfig ? String(saved.model_id || '').trim()
        : String(recordedTask?.request_model_id || taskOptions?.model_id || recordedTask?.model || exactProvider?.defaultModelId || '').trim(),
      thinking: [hasSavedConfig ? saved?.reasoning_effort : null, hasSavedConfig ? null : recordedTask?.reasoning_effort, hasSavedConfig ? null : taskOptions?.reasoning_effort, exactProvider?.reasoningEffort]
        .find((value) => THINKING_OPTIONS.some((item) => item.id === value)) || 'high',
    };
  }
  if (selector && !providerFromSelector(providers, selector, '')) {
    return {
      agentId: String(recordedTask?.agent_id || recordedTask?.profile_id || conversation?.agent_id || conversation?.profile_id || '').trim(),
      providerId: selector,
      modelId: String(recordedTask?.request_model_id || taskOptions?.model_id || recordedTask?.model || '').trim(),
      thinking: recordedTask?.reasoning_effort || taskOptions?.reasoning_effort || 'high',
    };
  }
  const taskProvider = recordedTask?.provider_key || recordedTask?.provider || '';
  const taskModel = recordedTask?.model || taskOptions?.model_id || recordedTask?.request_model_id || '';
  const provider = providerFromSelector(providers, selector, taskModel)
    || providers.find((item) => providerKeyMatches(item, taskProvider) && modelMatches(item, taskModel))
    || providers.find((item) => modelMatches(item, taskModel))
    || providers.find((item) => providerKeyMatches(item, taskProvider))
    || providers[0] || null;
  const hasRecordedTask = Boolean(recordedTask && (taskModel || taskProviderSelector(recordedTask) || recordedTask.agent_id || recordedTask.profile_id));
  const rememberedProvider = !hasRecordedTask && lastRunConfig?.providerId
    ? providers.find((item) => item.id === lastRunConfig.providerId) : null;
  const selectedProvider = rememberedProvider || provider;
  const conversationAgentId = String(recordedTask?.agent_id || recordedTask?.profile_id || conversation?.agent_id || conversation?.profile_id || '').trim();
  // Compatibility only: without a saved route or exact recorded identity, use
  // the legacy phone preference. A bound conversation agent still wins.
  const cachedProvider = rememberedConfig?.providerId
    ? providers.find((item) => item.id === rememberedConfig.providerId) : null;
  const agentId = conversationAgentId || String(rememberedConfig?.agentId || '').trim()
    || (!hasRecordedTask && lastRunConfig?.agentId) || agents[0]?.id || '';
  if (cachedProvider) {
    return {
      agentId,
      providerId: cachedProvider.id,
      // 模型照旧用记住的那个：模型目录是「配置 + 用过的」合并出来的，认不出不等于不存在
      // （见 `withCurrentModel`）。猜一个默认值反而会把用户刚选的模型默默换掉。
      modelId: String(rememberedConfig.modelId || cachedProvider.defaultModelId || cachedProvider.models[0]?.id || '').trim(),
      thinking: THINKING_OPTIONS.some((item) => item.id === rememberedConfig.thinking)
        ? rememberedConfig.thinking : 'high',
    };
  }
  const thinking = [recordedTask?.reasoning_effort, taskOptions?.reasoning_effort,
    (!hasRecordedTask && lastRunConfig?.thinking), selectedProvider?.reasoningEffort]
    .find((value) => THINKING_OPTIONS.some((item) => item.id === value)) || 'high';
  const rememberedModel = !hasRecordedTask && rememberedProvider && lastRunConfig.modelId
    ? lastRunConfig.modelId : '';
  const modelId = String(taskModel || rememberedModel || selectedProvider?.defaultModelId || selectedProvider?.models[0]?.id || '').trim();
  return { agentId, providerId: selectedProvider?.id || '', modelId, thinking };
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

// Re-read the current route immediately before start/retry. A user selection
// made in this screen (even while the read is pending) is deliberate, unlike an
// inferred cache entry. Read failures propagate: never send a guessed identity.
export async function runConfigForSend({ conversation, providers, agents, lastRunConfig, rememberedConfig, loadSavedConfig, getSelection }) {
  const selection = getSelection();
  if (selection.explicit) return selection.config;
  const saved = await loadSavedConfig();
  const current = getSelection();
  if (current.explicit) return current.config;
  return resolveRunConfig({ ...conversation, run_config: saved || conversation?.run_config }, providers, agents, lastRunConfig, rememberedConfig);
}

export function taskOptionsForRunConfig(config, providers) {
  const provider = providers.find((item) => item.id === config?.providerId);
  if (!provider || !config?.modelId) {
    throw new Error('The selected LLM configuration is unavailable. Reselect a configuration before sending.');
  }
  return {
    ...(provider.llmConfigId ? { llm_config_id: provider.llmConfigId } : { provider: provider.requestProvider }),
    model_id: config?.modelId || null,
    agent_id: config?.agentId || null,
    reasoning_effort: config?.thinking || 'high',
  };
}
