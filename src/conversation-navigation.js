// 会话列表与详情是同一个 SPA 里的两层，不该把“回到列表”伪装成一次断线或重新启动。
//
// iOS 原生边缘返回由 WKWebView 驱动 back/forward list；Web 层只负责维护这一层 history：
// 打开会话时 push，一次 popstate 只关闭当前详情。这样被揭开的列表仍是同一棵、已挂载的 React 树，
// 连接、目录、滚动位置都不重建。浏览器/PWA 仍走自己的本地关闭路径。
export const CONVERSATION_HISTORY_KEY = 'haishConversationId';

export function conversationIdFromHistory(state) {
  const value = state?.[CONVERSATION_HISTORY_KEY];
  return typeof value === 'string' ? value : '';
}

export function conversationHistoryState(state, conversationId) {
  const next = state && typeof state === 'object' ? { ...state } : {};
  if (conversationId) next[CONVERSATION_HISTORY_KEY] = String(conversationId);
  else delete next[CONVERSATION_HISTORY_KEY];
  return next;
}

export function replaceConversationHistory(history, conversationId, url) {
  history?.replaceState?.(conversationHistoryState(history.state, conversationId), '', url);
}

export function pushConversationHistory(history, conversationId, url) {
  if (!conversationId || conversationIdFromHistory(history?.state) === String(conversationId)) return false;
  history?.pushState?.(conversationHistoryState(history.state, conversationId), '', url);
  return true;
}

export function replacePendingConversationHistory(history, pendingId, conversationId, url) {
  if (!pendingId || conversationIdFromHistory(history?.state) !== String(pendingId)) return false;
  replaceConversationHistory(history, conversationId, url);
  return true;
}

/** A UI back action may run only when the current history entry owns this open detail. */
export function popConversationHistory(history, conversationId) {
  if (!conversationId || conversationIdFromHistory(history?.state) !== String(conversationId)) return false;
  history?.back?.();
  return true;
}
