// UIKit dispatches this event when the user chooses the native Add Comment selection command.
// Keeping the name in one module avoids a silent Swift/JavaScript bridge mismatch.
export const NATIVE_ADD_COMMENT_EVENT = 'haishNativeAddComment';
export const NATIVE_ANNOTATION_SELECTION_HANDLER = 'haishAnnotationSelection';

export function reportNativeAnnotationSelection(available, bridge = globalThis.webkit?.messageHandlers) {
  bridge?.[NATIVE_ANNOTATION_SELECTION_HANDLER]?.postMessage?.(Boolean(available));
}

export function addNativeCommentListener(handler, target = window) {
  if (!target?.addEventListener || typeof handler !== 'function') return () => {};
  target.addEventListener(NATIVE_ADD_COMMENT_EVENT, handler);
  return () => target.removeEventListener(NATIVE_ADD_COMMENT_EVENT, handler);
}
