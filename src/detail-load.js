// 首屏那一次「取整条会话」是**一次性**的：把它挤掉，下一次机会要等 15 秒的轮询，
// 用户在真机上看到的就是「进会话一片空白，退出去再进来又好了」。
//
// 让路（threadBusy：下拉手势 / 键盘动画 / 输入中）本来是为了别把 1.7MB 会话的解析和
// 整棵线程的重渲染塞进那些帧里。可首屏那一刻线程还是空的——没有会被挤掉的渲染，代价
// 却由用户来付：点一行会话的同时键盘正在收起（比如刚在搜索框里打完字），这一次请求
// 就被丢掉，于是空白十几秒。所以规则收紧成两条：
//
//   1. 还没 hydrate 之前一律不让路（首屏优先）；
//   2. 首屏落空（让路、网络抖动、runtime 正忙）不等轮询，快速退避重试几轮。
export const FIRST_LOAD_RETRY_MS = 700;
export const FIRST_LOAD_RETRY_LIMIT = 4;

/** 这一轮取会话要不要让路给手势/键盘。`hydrated` 为假时永远不让：那是首屏。 */
export function defersConversationFetch({ hydrated, keep, busy } = {}) {
  return !keep && Boolean(hydrated) && Boolean(busy);
}

/**
 * 第 `attempt` 次首屏重试之前等多久（0 起算）；返回 0 表示不再重试，交回 15 秒的轮询。
 * 700 / 1400 / 2800 / 5600 —— 覆盖 runtime 重启那种十几秒的抖动，又不会一直打。
 */
export function firstLoadRetryDelay(attempt, { delay = FIRST_LOAD_RETRY_MS, limit = FIRST_LOAD_RETRY_LIMIT } = {}) {
  const index = Number(attempt);
  if (!Number.isFinite(index) || index < 0 || index >= limit) return 0;
  return delay * 2 ** index;
}
