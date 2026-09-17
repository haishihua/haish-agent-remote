// Pull-to-refresh, built the way this app builds gestures (see swipe-back.js):
//
// - the pull is claimed only after 6px of movement that points down inside a 40° cone
//   around the vertical axis (the same cone the back swipe uses, rotated 90°), and only
//   while the surface is already at its top — a drag that starts anywhere else still
//   belongs to the scroller;
// - the surface travels with the finger through a resistance factor and a cap, which is
//   what makes the pull feel attached instead of 1:1;
// - releasing past the trigger distance starts a refresh; anything shorter settles back;
// - the refresh itself is the caller's promise. This module owns only when it starts, how
//   long the spinner has to stay on screen, and the shared "a pull owns the thread" flag
//   the polls check before they rebuild a list mid-gesture.

export const PULL_REFRESH_START_PX = 6;
export const PULL_REFRESH_MAX_ANGLE_DEG = 40;
export const PULL_REFRESH_RESISTANCE = 0.55;
/** Content travel that arms the refresh. */
export const PULL_REFRESH_TRIGGER_PX = 64;
/** Furthest the content travels, however hard the finger pulls. */
export const PULL_REFRESH_MAX_PX = 112;
/** Where the content waits while the refresh is in flight. */
export const PULL_REFRESH_HOLD_PX = 56;
export const PULL_REFRESH_HOLD_MS = 150;
export const PULL_REFRESH_SETTLE_MS = 240;
/** A fetch that returns instantly must still read as a refresh, not a flicker. */
export const PULL_REFRESH_MIN_SPIN_MS = 420;
export const PULL_REFRESH_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

let pullRefreshInFlight = false;

/** True between claiming a pull and the surface settling back: interactive work owns the thread. */
export function isPullRefreshInFlight() {
  return pullRefreshInFlight;
}

export function setPullRefreshInFlight(active) {
  pullRefreshInFlight = Boolean(active);
}

/** How far the content follows a downward finger travel, after resistance and the cap. */
export function pullRefreshDistance(deltaY, max = PULL_REFRESH_MAX_PX) {
  if (!(deltaY > 0)) return 0;
  return Math.min(deltaY * PULL_REFRESH_RESISTANCE, max);
}

/** How far the pull has travelled towards the trigger, 0..1 — this drives the indicator. */
export function pullRefreshProgress(distance, trigger = PULL_REFRESH_TRIGGER_PX) {
  if (!(trigger > 0)) return 0;
  return Math.min(1, Math.max(0, distance / trigger));
}

/**
 * Which axis owns the touch: `null` while it is still below the start threshold, `pull`
 * when it points down inside the cone, `scroll` for everything else (up, sideways, or too
 * diagonal) so those drags keep scrolling the list.
 */
export function pullRefreshAxis(deltaX, deltaY, threshold = PULL_REFRESH_START_PX) {
  if (Math.hypot(deltaX, deltaY) < threshold) return null;
  const angle = Math.abs(Math.atan2(deltaX, deltaY)) * (180 / Math.PI);
  return deltaY > 0 && angle <= PULL_REFRESH_MAX_ANGLE_DEG ? 'pull' : 'scroll';
}

/** Whether a released pull asks for a refresh or only settles back. */
export function pullRefreshArmed(distance, trigger = PULL_REFRESH_TRIGGER_PX) {
  return distance >= trigger;
}
