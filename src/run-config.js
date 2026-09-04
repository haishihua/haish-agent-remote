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

export function agentOptionsFromPayload(payload) {
  return (Array.isArray(payload) ? payload : payload?.agents || []).map((item) => ({
    id: String(item?.agent_id || item?.id || item?.profile_id || '').trim(),
    label: String(item?.display_name || item?.label || item?.agent_id || item?.id || '').trim(),
  })).filter((item) => item.id);
}

export function resolveRunConfig(conversation, providers, agents) {
  const tasks = Array.isArray(conversation?.tasks) ? conversation.tasks : [];
  const latestTask = tasks.find((task) => task?.task_id === conversation?.last_task_id) || tasks.at(-1) || null;
  const taskProvider = String(latestTask?.provider_key || latestTask?.provider || '').trim().toLowerCase().replaceAll('-', '_');
  const taskModel = String(latestTask?.model || '').trim();
  const provider = providers.find((item) => (
    (item.requestProvider === taskProvider || item.provider === taskProvider)
    && (!taskModel || item.defaultModelId === taskModel || item.models.some((model) => model.id === taskModel))
  )) || providers.find((item) => item.requestProvider === taskProvider || item.provider === taskProvider)
    || providers.find((item) => taskModel && (item.defaultModelId === taskModel || item.models.some((model) => model.id === taskModel)))
    || providers[0] || null;
  const conversationAgentId = String(latestTask?.agent_id || latestTask?.profile_id || conversation?.agent_id || conversation?.profile_id || '').trim();
  const agentId = conversationAgentId || agents[0]?.id || '';
  const thinking = THINKING_OPTIONS.some((item) => item.id === provider?.reasoningEffort)
    ? provider.reasoningEffort
    : 'high';
  const modelId = taskModel || provider?.defaultModelId || provider?.models[0]?.id || '';
  return { agentId, providerId: provider?.id || '', modelId, thinking };
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
