// An active editor owns the WebKit main thread. A short quiet period catches taps/commits around
// focus transitions; while the textarea remains focused, polling and stream commits stay buffered
// even when the user pauses to choose an IME candidate.
export const COMPOSER_INPUT_QUIET_MS = 800;
export const COMPOSER_FOCUS_RETRY_MS = 250;

export function createRecentInputActivity({ quietMs = COMPOSER_INPUT_QUIET_MS, now = Date.now } = {}) {
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let focused = false;

  return {
    mark(at = now()) {
      const value = Number(at);
      if (Number.isFinite(value)) lastInputAt = value;
      return lastInputAt;
    },
    setFocused(next) {
      focused = Boolean(next);
      return focused;
    },
    isFocused() {
      return focused;
    },
    remaining(at = now()) {
      const value = Number(at);
      if (!Number.isFinite(value)) return 0;
      const elapsed = value - lastInputAt;
      if (elapsed < 0) return 0;
      return Math.max(0, quietMs - elapsed);
    },
    isActive(at = now()) {
      return focused || this.remaining(at) > 0;
    },
    deferDelay(at = now()) {
      return focused ? COMPOSER_FOCUS_RETRY_MS : this.remaining(at);
    },
  };
}

const composerInputActivity = createRecentInputActivity();

export function markComposerInputActivity() {
  composerInputActivity.mark();
}

export function setComposerInputFocused(focused) {
  composerInputActivity.setFocused(focused);
}

export function isComposerInputFocused() {
  return composerInputActivity.isFocused();
}

export function isComposerInputActive() {
  return composerInputActivity.isActive();
}

export function composerInputQuietDelay() {
  return composerInputActivity.deferDelay();
}
