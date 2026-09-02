import { readNdjson } from './task-stream.js';
import {
  clearNativeConnection,
  initializeNativeConnection,
  isNativeApp,
  requestContext,
  saveNativeConnection,
  scanPairingCode,
} from './native-connection.js';

export const RECONNECT_TIMEOUT_MS = 15_000;

export function runtimeConnectionState(runtimeOnline, offlineSince, now = Date.now()) {
  if (runtimeOnline !== false) return null;
  const timedOut = Boolean(offlineSince && now - offlineSince >= RECONNECT_TIMEOUT_MS);
  return {
    timedOut,
    message: timedOut ? 'Unable to connect to Haish. Open the desktop app to retry.' : 'Reconnecting to Haish…',
  };
}

async function responseError(response) {
  let detail = `Request failed (${response.status})`;
  try {
    const body = await response.json();
    const candidate = body.detail || body.message;
    detail = typeof candidate === 'string' ? candidate : candidate?.[0]?.msg || detail;
  } catch {
    // Keep the HTTP fallback.
  }
  if (response.status >= 500) {
    try {
      const statusResponse = await remoteFetch('/remote/status');
      const status = statusResponse.ok ? await statusResponse.json() : null;
      if (status?.runtime_online === false) detail = 'Reconnecting to Haish…';
    } catch {
      // Keep the original server error when connection state cannot be checked.
    }
  }
  const error = new Error(detail);
  error.status = response.status;
  return error;
}

async function remoteFetch(path, init = {}, endpoint) {
  const context = requestContext(path, endpoint);
  return fetch(context.url, {
    ...init,
    credentials: context.credentials,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(context.token ? { Authorization: `Bearer ${context.token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

async function request(path, init = {}, endpoint) {
  const response = await remoteFetch(path, init, endpoint);
  if (!response.ok) {
    const error = await responseError(response);
    if (error.status === 401) await clearNativeConnection();
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export const api = {
  isNative: isNativeApp,
  initialize: initializeNativeConnection,
  scanPairingCode,
  status: () => request('/remote/status'),
  pair: async (code, endpoint) => {
    const result = await request('/remote/pairing/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }, endpoint);
    if (isNativeApp) await saveNativeConnection(endpoint, result.token);
    return result;
  },
  projects: () => request('/api/projects?execution_mode=chat'),
  conversation: (id) => request(`/api/conversations/${encodeURIComponent(id)}`),
  task: (id) => request(`/api/tasks/${encodeURIComponent(id)}?event_view=runtime`),
  agents: async () => {
    try {
      return await request('/api/agents');
    } catch (error) {
      if (error.status < 500) throw error;
      return request('/api/agents');
    }
  },
  llmSettings: () => request('/api/settings/llm'),
  providerModels: (provider) => request('/api/llm/models', {
    method: 'POST',
    body: JSON.stringify({
      provider: provider.provider,
      auth_mode: provider.authMode,
      custom_provider: provider.customProvider,
      base_url: provider.baseUrl,
      model: provider.defaultModelId,
      refresh: true,
    }),
  }),
  approvals: () => request('/api/approvals/state'),
  createConversation: (projectId) => request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: 'New task', execution_mode: 'chat', project_id: projectId || undefined }),
  }),
  uploadImage: (conversationId, file) => {
    const body = new FormData();
    body.append('conversation_id', conversationId);
    body.append('file', file);
    return request('/api/messages/images', { method: 'POST', body });
  },
  imagePreview: async (conversationId, path) => {
    const previewPath = `/api/conversations/${encodeURIComponent(conversationId)}/messages/images/preview?image_path=${encodeURIComponent(path)}`;
    const response = await remoteFetch(previewPath);
    if (!response.ok) throw await responseError(response);
    return response.blob();
  },
  startTask: async (conversation, message, imageAttachments, runOptions, onEvent, onOpen) => {
    const response = await remoteFetch(`/remote/conversations/${encodeURIComponent(conversation.conversation_id)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        image_attachments: imageAttachments,
        options: {
          execution_mode: conversation.execution_mode || 'chat',
          ...runOptions,
          use_history: true,
        },
      }),
    });
    if (!response.ok) throw await responseError(response);
    onOpen?.();
    await readNdjson(response, onEvent);
  },
  sendInput: (taskId, message) => request(`/api/tasks/${encodeURIComponent(taskId)}/inputs`, {
    method: 'POST',
    body: JSON.stringify({ message, mode: 'steering' }),
  }),
  stopTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  stopConversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/cancel`, { method: 'POST' }),
  resolveApproval: (requestId, decision) => request(`/api/approvals/${encodeURIComponent(requestId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  }),
  resolveWorkflow: (requestId, decision, feedback = '') => request(`/api/workflow-approvals/${encodeURIComponent(requestId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ decision, feedback }),
  }),
  resolveInput: (requestId, answers) => request(`/api/user-inputs/${encodeURIComponent(requestId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  }),
  devices: () => request('/remote/devices'),
  revokeDevice: (id) => request(`/remote/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logout: async () => {
    try {
      return await request('/remote/logout', { method: 'POST' });
    } finally {
      await clearNativeConnection();
    }
  },
  forgetConnection: clearNativeConnection,
};
