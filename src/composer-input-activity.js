// Typing must win the main thread over background polling. This module records only a short
// quiet window after the latest input event; it does not treat an open keyboard as permanently
// busy, so updates resume as soon as the user pauses.
export const COMPOSER_INPUT_QUIET_MS = 800;

export function createRecentInputActivity({ quietMs = COMPOSER_INPUT_QUIET_MS, now = Date.now } = {}) {
  let lastInputAt = Number.NEGATIVE_INFINITY;

  return {
    mark(at = now()) {
      const value = Number(at);
      if (Number.isFinite(value)) lastInputAt = value;
      return lastInputAt;
    },
    remaining(at = now()) {
      const value = Number(at);
      if (!Number.isFinite(value)) return 0;
      const elapsed = value - lastInputAt;
      if (elapsed < 0) return 0;
      return Math.max(0, quietMs - elapsed);
    },
    isActive(at = now()) {
      return this.remaining(at) > 0;
    },
  };
}

const composerInputActivity = createRecentInputActivity();

export function markComposerInputActivity() {
  composerInputActivity.mark();
}

export function isComposerInputActive() {
  return composerInputActivity.isActive();
}

export function composerInputQuietDelay() {
  return composerInputActivity.remaining();
}
