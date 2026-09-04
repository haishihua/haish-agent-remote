export const SWIPE_BACK_EDGE_PX = 32;

export function swipeBackOffset(start, current) {
  if (!start || !current) return 0;
  const deltaX = current.x - start.x;
  const deltaY = Math.abs(current.y - start.y);
  if (deltaX <= 0 || deltaY > Math.max(14, deltaX)) return 0;
  return Math.min(deltaX, 120);
}

export function isSwipeBackGesture(start, end) {
  if (!start || !end || start.x > SWIPE_BACK_EDGE_PX) return false;
  const deltaX = end.x - start.x;
  const deltaY = Math.abs(end.y - start.y);
  return deltaX >= 88 && deltaX > deltaY * 1.4;
}
