/**
 * 长线程的渲染窗口。
 *
 * iOS 17 的 WebKit 还没有 content-visibility（Safari 18 才有），`.chat-row` 那条「滚出视野就
 * 不再布局」在这台机器上等于没有：几百条消息的线程，每一次布局、每一次 AX 快照、每一次聚焦都要
 * 走完全部节点——真机上就是「点输入框要等两三秒」（实测 2.8s）。所以只挂最新的一段，历史由线程
 * 顶部那个按钮一段一段叫回来（和目录里的 Show more 同一套思路）。
 *
 * 行还是整份会话的行：引用块的编号、审批插槽、时间线都照旧，只有渲染被裁。
 */
export const THREAD_WINDOW_ROWS = 40;
export const THREAD_WINDOW_STEP = 40;

/** 窗口的第一条行在整份行列表里的下标（0 = 整条线程都在窗口里）。 */
export function threadWindowStart(rowCount, size) {
  const total = Math.max(0, Number(rowCount) || 0);
  const window = Math.max(1, Number(size) || 0);
  return Math.max(0, total - window);
}

/** 要多少行才能把这一行装进窗口（引用跳转用；目标不在列表里就返回 0）。 */
export function rowsToReveal(rows, rowId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!rowId) return 0;
  const index = list.findIndex((row) => row.id === rowId || row.messageId === rowId);
  return index < 0 ? 0 : list.length - index;
}

/**
 * 把更早的一段叫回来。
 *
 * 补进来的是**视野上方**的内容：滚动的像素值如果不补，正在读的那一段就会往下跳一截。
 * 所以先记下补之前的 `scrollHeight`，等 React 落完这一帧再把差值加回 `scrollTop`。
 * 测量和写入都在下一帧里——这一帧的布局本来就是脏的。
 */
export function extendThreadWindow({
  scroller = null,
  setSize,
  step = THREAD_WINDOW_STEP,
  frame = (callback) => requestAnimationFrame(callback),
} = {}) {
  const before = scroller ? scroller.scrollHeight : 0;
  setSize?.((current) => current + step);
  if (!scroller) return before;
  frame(() => {
    const delta = scroller.scrollHeight - before;
    if (delta > 0) scroller.scrollTop += delta;
  });
  return before;
}
