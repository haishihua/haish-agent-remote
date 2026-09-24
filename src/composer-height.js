/**
 * 输入框跟着草稿长高，不再预留一块固定高度的空白。
 *
 * 之前展开态把 textarea 钉在 82px：两行草稿下面会留出一条空带，而超过 82px 的草稿又在框内滚动。
 * 现在高度按内容算一遍，最小是 CSS 的单行高度，最大是 CSS 的 max-height，超出才在框内滚动。
 * 上下限仍然只在 `src/styles.css` 的 `.composer textarea` 里定义一份，这里读计算后的样式。
 *
 * 量一次不便宜：`height = auto` 先把整页布局打脏，紧接着读 `scrollHeight` 又要当场把它算回来
 * （页面里几千个节点时就是一次几十毫秒的强制布局）。每个按键都走这条路，输入就会一顿一顿——
 * 手机上就是「打字不跟手」。所以分成三条路：
 *
 * - 草稿没变、也没要求强制重量：直接返回上一次的结果，一次布局都不碰；
 * - 草稿变长（或换了行结构）：不写 `auto`，直接读一次 `scrollHeight`——内容溢出时它就是内容
 *   高度，没溢出时等于框高，算出来的高度不高于当前高度就什么都不写（写 CSS 同样让布局失效）；
 * - 草稿变短，或者调用方标了 `force`（宽度变了）：走完整的一次 `auto` 重量，让框跟着缩回去。
 */
export const COMPOSER_TEXTAREA_MIN_HEIGHT = 48;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 132;

/** 每个元素上一次量到的上下限与结果（`value` 用来判断草稿有没有变过）。 */
const fitted = new WeakMap();

function toPixels(value, fallback) {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : fallback;
}

/** 把量到的内容高度夹到样式允许的区间里。 */
export function composerTextareaHeight(contentHeight, { minHeight, maxHeight } = {}) {
  const content = Math.ceil(Number(contentHeight) || 0);
  const min = toPixels(minHeight, COMPOSER_TEXTAREA_MIN_HEIGHT);
  const max = Math.max(min, toPixels(maxHeight, COMPOSER_TEXTAREA_MAX_HEIGHT));
  return Math.min(Math.max(content, min), max);
}

/**
 * 上一次量完之后草稿是不是变短了：只有变短（含行数变少）才需要 `auto` 那一道，因为不写 `auto`
 * 读到的是「框还装得下」的假高度，框只会长高不会变矮。
 */
function draftMayShrink(value, previous) {
  return value.length < previous.length
    || value.split('\n').length < previous.split('\n').length;
}

/**
 * 量一次 textarea 的内容高度并把它设成实际高度，返回设进去的像素值。
 * `force` 是「宽度变了」的意思（展开、旋转屏幕、右侧图标出现）：同一份草稿的折行会变，必须重量。
 * 上下限是样式表里的 px 常量，每个元素只读一次——它不跟字号走。
 */
export function fitComposerTextarea(textarea, { getStyles = (node) => getComputedStyle(node), force = false } = {}) {
  if (!textarea) return 0;
  const previous = fitted.get(textarea) || null;
  const size = previous?.size || (() => {
    const styles = getStyles(textarea);
    return { minHeight: styles.minHeight, maxHeight: styles.maxHeight };
  })();
  const value = String(textarea.value ?? '');
  if (!force && previous && previous.value === value) return previous.height;
  const current = toPixels(textarea.style?.height, 0);
  let height;
  if (force || !previous || draftMayShrink(value, previous.value)) {
    // 内容可能缩短：先设 `auto` 才能量到缩短后的高度，否则框只会长高不会变矮。
    textarea.style.height = 'auto';
    height = composerTextareaHeight(textarea.scrollHeight, size);
    textarea.style.height = `${height}px`;
  } else {
    height = composerTextareaHeight(textarea.scrollHeight, size);
    // 内容还装得下时 `scrollHeight` 报的就是框高：没有变高就一个字节都不写。
    if (height !== current) textarea.style.height = `${height}px`;
  }
  fitted.set(textarea, { size, value, height });
  return height;
}

/**
 * Coalesce rapid input events into one layout read per animation frame. The input value itself is
 * still updated synchronously by React; only the optional auto-height measurement is deferred.
 *
 * `shouldDefer` is the keyboard's own guard: while the keyboard is moving, a `height: auto` write
 * plus a `scrollHeight` read is a forced layout that lands exactly when the keyboard event is
 * trying to reach the page — the composer then starts its travel a frame or two late (the reported
 * "the keyboard is already up, the input bar is still below"), and WebKit is also mid-way through
 * rebuilding its marked text, where a height write can drag the caret. The measurement waits for
 * the motion to land instead, with `deferLimitMs` as a hard stop in case the state never clears.
 */
export const COMPOSER_FIT_DEFER_LIMIT_MS = 900;

export function createComposerTextareaFitScheduler({
  fit = fitComposerTextarea,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
  shouldDefer = () => false,
  now = () => Date.now(),
  deferLimitMs = COMPOSER_FIT_DEFER_LIMIT_MS,
} = {}) {
  let frame = 0;
  let textarea = null;
  let force = false;
  let deferUntil = 0;

  function flush() {
    frame = 0;
    if (shouldDefer() && now() < deferUntil) {
      frame = requestFrame(flush);
      return 0;
    }
    const target = textarea;
    const shouldForce = force;
    textarea = null;
    force = false;
    deferUntil = 0;
    return fit(target, { force: shouldForce });
  }

  function schedule(nextTextarea, options = {}) {
    textarea = nextTextarea;
    force = force || Boolean(options.force);
    deferUntil = now() + deferLimitMs;
    if (!frame) frame = requestFrame(flush);
    return frame;
  }

  function cancel() {
    if (frame) cancelFrame(frame);
    frame = 0;
    textarea = null;
    force = false;
    deferUntil = 0;
  }

  return { schedule, flush, cancel };
}

/**
 * A native keyboard transition can emit `window.resize` even though only the viewport height
 * changed. Re-fitting the textarea for those events writes `height: auto` and synchronously reads
 * `scrollHeight` while WebKit is also maintaining marked text and the caret. Only a viewport-width
 * change can alter wrapping, so remember that cheap scalar and force a fit only when it changes.
 */
export function createComposerViewportResizeHandler({
  readWidth = () => window.innerWidth,
  getTextarea = () => null,
  schedule = () => {},
  shouldSchedule = () => true,
} = {}) {
  const measuredWidth = () => {
    const value = Number(readWidth());
    return Number.isFinite(value) ? Math.round(value) : null;
  };
  let width = measuredWidth();

  return function handleViewportResize() {
    const next = measuredWidth();
    if (next === null || next === width) return false;
    // Keep the old width while the caller is in an IME composition. Calling this handler again at
    // compositionend will then perform the deferred forced fit with no extra state or timer.
    if (!shouldSchedule()) return false;
    width = next;
    const textarea = getTextarea();
    if (!textarea) return false;
    schedule(textarea, { force: true });
    return true;
  };
}
