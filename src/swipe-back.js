export const SWIPE_BACK_EDGE_PX = 32;
export const SWIPE_BACK_MIN_FLING_PX = 36;
export const SWIPE_BACK_FLING_VELOCITY = 0.55;

export function swipeBackOffset(start, current, maxOffset = Number.POSITIVE_INFINITY) {
  if (!start || !current) return 0;
  const deltaX = current.x - start.x;
  return Math.min(Math.max(0, deltaX), maxOffset);
}

export function isSwipeBackGesture(start, end, { width = 320, elapsedMs = Number.POSITIVE_INFINITY } = {}) {
  if (!start || !end || start.x > SWIPE_BACK_EDGE_PX) return false;
  const deltaX = end.x - start.x;
  const deltaY = Math.abs(end.y - start.y);
  const distanceThreshold = Math.min(112, width * 0.3);
  const velocity = elapsedMs > 0 ? deltaX / elapsedMs : 0;
  const deliberateDrag = deltaX >= distanceThreshold;
  const quickFling = deltaX >= SWIPE_BACK_MIN_FLING_PX && velocity >= SWIPE_BACK_FLING_VELOCITY;
  return deltaX > deltaY * 1.4 && (deliberateDrag || quickFling);
}
