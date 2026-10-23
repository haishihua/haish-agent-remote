// 轻提示（toast）：**用户动作**造成的一句话反馈——保存/撤销/上传/校验失败、被前置
// 条件挡住——不该在页面上占一行固定版面。桌面的 `AppToast` / `AppToastStack` 就是这条
// 分工（见 `app-web/styles/modals.css` 那一段注释与 `createConversationRuntime.js` 的
// 计时器注册表），手机这边照同一套语义实现，样式在 `styles.css` 里按手机尺寸写。
//
// 持续状态不进 toast：断线横幅、加载失败的卡片、桌面会话的连接状态都留在页面上——
// 提示会消失，状态不能消失。
import React from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

// 与桌面一致：3 条上限、3.2 秒寿命。
export const TOAST_STACK_LIMIT = 3;
export const TOAST_LIFETIME_MS = 3200;

const TOAST_GLYPHS = {
  success: Check,
  error: X,
  warn: AlertTriangle,
  info: Info,
};

/**
 * 队列语义照抄桌面：`kind + message` 去重（重复触发只把计时器往后续，不叠第二条），
 * 超过上限先丢「最早到期」的那条。返回的 `pushToast` 身份稳定，可以直接塞进
 * `useCallback` / memo 组件的依赖里。
 */
export function useToasts() {
  const [toasts, setToasts] = React.useState([]);
  const registryRef = React.useRef(new Map());

  const pushToast = React.useCallback((kind, message) => {
    const text = message == null ? '' : String(message).trim();
    if (!text) return;
    const tone = TOAST_GLYPHS[kind] ? kind : 'info';
    const registry = registryRef.current;
    const key = `${tone}\u0000${text}`;
    const existing = registry.get(key);
    const id = existing?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const expiresAt = Date.now() + TOAST_LIFETIME_MS;
    let evictedId = null;
    if (!existing) {
      while (registry.size >= TOAST_STACK_LIMIT) {
        let victimKey = null;
        let victim = null;
        for (const [candidateKey, entry] of registry) {
          if (!victim || entry.expiresAt < victim.expiresAt) {
            victimKey = candidateKey;
            victim = entry;
          }
        }
        clearTimeout(victim.timerId);
        registry.delete(victimKey);
        evictedId = victim.id;
      }
    }
    if (existing) clearTimeout(existing.timerId);
    const timerId = setTimeout(() => {
      const current = registry.get(key);
      if (current?.id === id) registry.delete(key);
      // 只摘自己这条：期间可能已经弹出了更新的提示。
      setToasts((queued) => queued.filter((toast) => toast.id !== id));
    }, TOAST_LIFETIME_MS);
    registry.set(key, { id, timerId, expiresAt });
    if (existing) return;
    setToasts((queued) => {
      const kept = queued.filter((toast) => toast.id !== evictedId);
      return [...kept, { id, kind: tone, message: text }].slice(-TOAST_STACK_LIMIT);
    });
  }, []);

  React.useEffect(() => () => {
    // 卸载时清掉未到期的计时器，避免回调打到已经卸载的组件上。
    for (const entry of registryRef.current.values()) clearTimeout(entry.timerId);
    registryRef.current.clear();
  }, []);

  return { toasts, pushToast };
}

export function ToastStack({ toasts = [] }) {
  const visible = Array.isArray(toasts) ? toasts.filter((toast) => toast?.message) : [];
  if (!visible.length) return null;
  return (
    <div className="app-toast-stack">
      {visible.map((toast) => {
        const Glyph = TOAST_GLYPHS[toast.kind] || TOAST_GLYPHS.info;
        return (
          <div className={`app-toast app-toast-${toast.kind}`} role="status" aria-live="polite" key={toast.id}>
            <span className="app-toast-icon" aria-hidden="true"><Glyph size={15} strokeWidth={2} /></span>
            <span className="app-toast-message">{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}
