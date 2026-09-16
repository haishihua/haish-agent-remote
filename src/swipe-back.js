export const SWIPE_BACK_EDGE_PX = 32;
export const SWIPE_BACK_MIN_FLING_PX = 36;
export const SWIPE_BACK_FLING_VELOCITY = 0.55;
export const SWIPE_BACK_AXIS_THRESHOLD_PX = 4;

export function swipeBackOffset(start, current, maxOffset = Number.POSITIVE_INFINITY) {
  if (!start || !current) return 0;
  const deltaX = current.x - start.x;
  return Math.min(Math.max(0, deltaX), maxOffset);
}

// The axis has to be settled after a few pixels: while it is undecided the scroll
// view is still free to take the finger, and once it scrolls the WebView stops
// delivering touch moves until the scroll settles. Pulling right is the only
// gesture this screen owns; anything else belongs to the thread underneath.
export function swipeBackAxis(deltaX, deltaY, threshold = SWIPE_BACK_AXIS_THRESHOLD_PX) {
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < threshold) return null;
  return deltaX > 0 && deltaX >= deltaY * 1.1 ? 'horizontal' : 'vertical';
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
