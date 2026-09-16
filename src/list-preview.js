import { CONVERSATION_PREVIEW_LIMIT } from './conversation-order.js';

// Mirrors the desktop sidebar (`app-web/src/features/conversations/model/list-preview.js`):
// a list always starts from three rows, "Show more" reveals three more, and once
// the last row is visible the button reads "Show less" and folds back to the
// default preview (it resets to zero extra rows, not three fewer).
export const DEFAULT_PREVIEW = 0;

export function nextExtraVisible(current, hiddenCount) {
  return hiddenCount > 0 ? current + Math.min(CONVERSATION_PREVIEW_LIMIT, hiddenCount) : DEFAULT_PREVIEW;
}

// "Show more" is view state, not user data: folding the list away — the project
// icon, or the pinned section — drops the expansion, so opening it again shows
// the default three rows again.
export function previewWhenHidden(extraVisible, listVisible) {
  return listVisible ? extraVisible : DEFAULT_PREVIEW;
}

// What the section should paint for one `extraVisible` value. A search passes an
// unbounded limit: the cap is a browsing default, so every match stays visible
// and there is no toggle to press.
export function previewRows(rows, extraVisible, limit = CONVERSATION_PREVIEW_LIMIT) {
  const list = Array.isArray(rows) ? rows : [];
  const previewLimit = Number.isFinite(limit) ? Math.max(0, limit) : list.length;
  const extra = Math.max(0, Number(extraVisible) || 0);
  const visible = list.slice(0, previewLimit + extra);
  const hiddenCount = Math.max(0, list.length - visible.length);
  return {
    visible,
    hiddenCount,
    showToggle: hiddenCount > 0 || (extra > 0 && Number.isFinite(limit)),
  };
}
