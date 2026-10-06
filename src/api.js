import { readNdjson } from './task-stream.js';
import { diagnoseRequestError } from './request-diagnostics.js';
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

const responseContexts = new WeakMap();

async function remoteFetch(path, init = {}, endpoint) {
  const diagnostic = { path, method: init.method || 'GET', startedAt: Date.now(), stage: 'build-url' };
  try {
    const context = requestContext(path, endpoint);
    diagnostic.stage = 'fetch';
    const response = await fetch(context.url, {
      ...init,
      credentials: context.credentials,
      headers: {
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(context.token ? { Authorization: `Bearer ${context.token}` } : {}),
        ...(init.headers || {}),
      },
    });
    responseContexts.set(response, { ...diagnostic, response, signal: init.signal });
    return response;
  } catch (error) {
    if (init.signal?.aborted) diagnostic.stage = 'timeout';
    throw diagnoseRequestError(error, diagnostic);
  }
}

async function consumeResponse(response, stage, consume) {
  const context = responseContexts.get(response);
  try {
    if (!response.ok) {
      context.stage = 'http';
      const error = await responseError(response);
      if (error.status === 401) await clearNativeConnection();
      throw error;
    }
    context.stage = stage;
    return await consume(context);
  } catch (error) {
    if (context.signal?.aborted) context.stage = 'timeout';
    throw diagnoseRequestError(error, context);
  }
}

async function request(path, init = {}, endpoint) {
  const response = await remoteFetch(path, init, endpoint);
  return consumeResponse(response, 'json-read', async (context) => {
    if (response.status === 204) return null;
    // Separate body-read failures from JSON syntax errors without retaining any
    // payload. Empty/HTML/malformed responses are distinguishable by type + size.
    const text = await response.text();
    context.responseChars = text.length;
    context.stage = 'json-parse';
    return JSON.parse(text);
  });
}

export async function requestWithTimeout(path, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(path, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function desktopRequest(path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await request(path, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

export const api = {
  isNative: isNativeApp,
  initialize: initializeNativeConnection,
  scanPairingCode,
  status: () => requestWithTimeout('/remote/status'),
  desktopStatus: () => requestWithTimeout('/remote/desktop/status'),
  desktopIce: () => requestWithTimeout('/remote/desktop/ice'),
  desktopOffer: (offer) => desktopRequest('/remote/desktop/offer', {
    method: 'POST', body: JSON.stringify(offer),
  }, 20_000),
  desktopEnd: (id) => desktopRequest(`/remote/desktop/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }, 5_000),
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
  // `afterEventId` is the desktop's incremental protocol: the runtime answers
  // with `events_delta: true` and only the events after the cursor, or with the
  // whole log (`false`) when the cursor is too old to resolve.
  task: (id, { afterEventId = null } = {}) => {
    const cursor = afterEventId ? `&after_event_id=${encodeURIComponent(afterEventId)}` : '';
    return request(`/api/tasks/${encodeURIComponent(id)}?event_view=runtime${cursor}`);
  },
  agents: async () => {
    try {
      return await request('/api/agents');
    } catch (error) {
      if (error.status < 500) throw error;
      return request('/api/agents');
    }
  },
  llmSettings: () => request('/api/settings/llm'),
  providerModels: async (provider) => {
    const body = {
      provider: provider.provider,
      auth_mode: provider.authMode,
      custom_provider: provider.customProvider,
      base_url: provider.baseUrl,
      model: provider.defaultModelId,
      refresh: true,
    };
    try {
      return await request('/api/llm/models', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (error) {
      // OAuth catalog refresh can fail when the upstream token has expired. The runtime still
      // owns a durable built-in catalog; ask for it explicitly instead of collapsing the picker
      // to whichever single model happens to be saved in settings.
      if (error.status !== 400) throw error;
      return request('/api/llm/models', {
        method: 'POST',
        body: JSON.stringify({ ...body, refresh: false }),
      });
    }
  },
  approvals: () => request('/api/approvals/state'),
  // 占位名取桌面默认名里那句中性的（`conversation-title.js` 的 `NEW_CONVERSATION_TITLE`，两处
  // 必须一致）：两边都认它是占位名，谁先把第一条消息发出去，谁就把它换成一句话摘要。
  createConversation: (projectId) => request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: 'New Chat', execution_mode: 'chat', project_id: projectId || undefined }),
  }),
  updateConversation: (id, patch) => request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),
  uploadImage: (conversationId, file, { signal } = {}) => {
    const body = new FormData();
    body.append('conversation_id', conversationId);
    body.append('file', file);
    return request('/api/messages/images', { method: 'POST', body, signal });
  },
  imagePreview: async (conversationId, path) => {
    const previewPath = `/api/conversations/${encodeURIComponent(conversationId)}/messages/images/preview?image_path=${encodeURIComponent(path)}`;
    const response = await remoteFetch(previewPath);
    return consumeResponse(response, 'blob-read', () => response.blob());
  },
  // 引用批注（桌面的「添加注释」）随消息一起走：runtime 把每条 quote 作为「被引用的原文 +
  // 用户的评论」拼进这一轮的上下文（见 core 的 app/annotations.py），所以它属于 task 的
  // 请求体，而不是事后追加的 inputs（steering 不接受 annotations）。
  startTask: async (conversation, message, imageAttachments, runOptions, onEvent, onOpen, annotations = []) => {
    const response = await remoteFetch(`/remote/conversations/${encodeURIComponent(conversation.conversation_id)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        image_attachments: imageAttachments,
        annotations,
        options: {
          execution_mode: conversation.execution_mode || 'chat',
          ...runOptions,
          use_history: true,
        },
      }),
    });
    await consumeResponse(response, 'stream-open', async () => {
      // Acceptance and callbacks keep their existing order; diagnostics must not
      // change draft recovery or introduce task-start retries.
      onOpen?.();
      await readNdjson(response, onEvent);
    });
  },
  sendInput: (taskId, message, imageAttachments = []) => request(`/api/tasks/${encodeURIComponent(taskId)}/inputs`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      image_attachments: imageAttachments.map((image) => ({
        image_id: image.image_id,
        path: image.path,
        mime: image.mime || null,
      })),
    }),
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
  conversationReads: () => request('/remote/conversation-reads'),
  markConversationRead: (conversationId, seenAtMs = Date.now()) => request(
    `/remote/conversation-reads/${encodeURIComponent(conversationId)}`,
    { method: 'PUT', body: JSON.stringify({ seen_at_ms: seenAtMs }) },
  ),
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
