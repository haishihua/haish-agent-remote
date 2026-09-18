// Interactive back swipe, built the way the platform builds it:
//
// - a pan recognizer claims the pull only when it starts at the left edge and stays
//   inside a 40° cone around the horizontal axis, so a vertical drag from the edge is
//   still a scroll (Ionic's recognizer and UIKit's edge pan work the same way);
// - progress is travel / screen width and is applied through the Web Animations API:
//   writing the offset into a custom property on every touch move recalculates style
//   for the whole message list, moving an animation's own time does not;
// - release completes on a fling (> 0.2 px/ms) or past half the screen, and settles
//   over the remaining distance / velocity, which is what keeps the page attached to
//   the finger instead of to a fixed duration. A flick *back* to the left cancels it,
//   but only a real one: the few pixels the finger drifts back while it lifts off
//   (velocity a hair below zero) used to cancel a pull that had already crossed half
//   the screen — iOS decides on the position in that case, so we do too.

export const SWIPE_BACK_EDGE_PX = 50;
export const SWIPE_BACK_THRESHOLD_PX = 8;
export const SWIPE_BACK_MAX_ANGLE_DEG = 40;
export const SWIPE_BACK_FLING_VELOCITY = 0.2;
/** 明确往回（向左）甩才取消：手指离屏那一下的抖动不该把过了半屏的一划弹回来。 */
export const SWIPE_BACK_CANCEL_VELOCITY = -0.2;
export const SWIPE_BACK_VELOCITY_SMOOTHING = 0.7;
export const SWIPE_BACK_SETTLE_VELOCITY_FLOOR = 0.5;
export const SWIPE_BACK_MIN_SETTLE_MS = 90;
export const SWIPE_BACK_MAX_SETTLE_MS = 340;
export const SWIPE_BACK_COMPLETE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const SWIPE_BACK_CANCEL_EASING = 'cubic-bezier(1, 0, 0.68, 0.28)';
/** Length of the linear timeline the pull is scrubbed on (`animation.currentTime`). */
export const SWIPE_BACK_TRACK_MS = 1000;

let swipeBackInFlight = false;

/** True between claiming a pull and the surface settling: interactive work owns the thread. */
export function isSwipeBackInFlight() {
  return swipeBackInFlight;
}

export function setSwipeBackInFlight(active) {
  swipeBackInFlight = Boolean(active);
}

export function swipeBackOffset(start, current, maxOffset = Number.POSITIVE_INFINITY) {
  if (!start || !current) return 0;
  const deltaX = current.x - start.x;
  return Math.min(Math.max(0, deltaX), maxOffset);
}

/**
 * Which axis owns the touch: `null` while the movement is still below the pan threshold,
 * `horizontal` when it points right inside the cone, `vertical` for everything else.
 */
export function swipeBackAxis(deltaX, deltaY, threshold = SWIPE_BACK_THRESHOLD_PX) {
  if (Math.hypot(deltaX, deltaY) < threshold) return null;
  const angle = Math.abs(Math.atan2(deltaY, deltaX)) * (180 / Math.PI);
  return deltaX > 0 && angle <= SWIPE_BACK_MAX_ANGLE_DEG ? 'horizontal' : 'vertical';
}

/** How far the pull has travelled across the screen, 0..1. */
export function swipeBackProgress(offset, width) {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, offset / width));
}

/** Smoothed px/ms velocity, the same 0.7 / 0.3 blend Ionic feeds into its release maths. */
export function swipeBackVelocity(previous, { deltaX = 0, deltaMs = 0 } = {}) {
  if (!(deltaMs > 0) || deltaMs >= 100) return previous;
  const instant = deltaX / deltaMs;
  return instant * SWIPE_BACK_VELOCITY_SMOOTHING + previous * (1 - SWIPE_BACK_VELOCITY_SMOOTHING);
}

/**
 * Where a released pull has to go and how long it may take: a fling finishes, everything
 * else returns, and either way the page keeps the speed the finger left it with.
 */
export function swipeBackRelease({ offset = 0, width = 0, velocity = 0 } = {}) {
  const step = swipeBackProgress(offset, width);
  // 和 iOS 的滑退一样：甩过去就算，或者看松手时过了半屏没有。只有明确往回甩才取消——
  // 手指离开屏幕前回那一点点（速度只负一丁点）不算，否则拖过了半屏也会弹回去。
  const flung = velocity > SWIPE_BACK_FLING_VELOCITY;
  const pulledBack = velocity <= SWIPE_BACK_CANCEL_VELOCITY;
  const complete = flung || (!pulledBack && offset > width / 2);
  const missing = (complete ? 1 - step : step) * width;
  const speed = Math.max(Math.abs(velocity), SWIPE_BACK_SETTLE_VELOCITY_FLOOR);
  const durationMs = missing <= 5
    ? 0
    : Math.min(Math.max(missing / speed, SWIPE_BACK_MIN_SETTLE_MS), SWIPE_BACK_MAX_SETTLE_MS);
  return {
    complete,
    step,
    durationMs: Math.round(durationMs),
    easing: complete ? SWIPE_BACK_COMPLETE_EASING : SWIPE_BACK_CANCEL_EASING,
  };
}
