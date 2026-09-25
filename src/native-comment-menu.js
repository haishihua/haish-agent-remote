// UIKit dispatches this event when the user chooses the native Add Comment selection command.
// Keeping the name in one module avoids a silent Swift/JavaScript bridge mismatch.
export const NATIVE_ADD_COMMENT_EVENT = 'haishNativeAddComment';
export const NATIVE_ANNOTATION_SELECTION_HANDLER = 'haishAnnotationSelection';

const lastAvailabilityByHandler = new WeakMap();

export function reportNativeAnnotationSelection(available, bridge = globalThis.webkit?.messageHandlers) {
  const handler = bridge?.[NATIVE_ANNOTATION_SELECTION_HANDLER];
  if (!handler?.postMessage) return;
  const next = Boolean(available);
  // IME marked-text updates can emit many selectionchange events per character. The native menu only
  // needs edge transitions, never a repeated stream of the same boolean across the WKWebView bridge.
  if (lastAvailabilityByHandler.get(handler) === next) return;
  lastAvailabilityByHandler.set(handler, next);
  handler.postMessage(next);
}

export function addNativeCommentListener(handler, target = window) {
  if (!target?.addEventListener || typeof handler !== 'function') return () => {};
  target.addEventListener(NATIVE_ADD_COMMENT_EVENT, handler);
  return () => target.removeEventListener(NATIVE_ADD_COMMENT_EVENT, handler);
}
