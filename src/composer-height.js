/**
 * 输入框跟着草稿长高，不再预留一块固定高度的空白。
 *
 * 之前展开态把 textarea 钉在 82px：两行草稿下面会留出一条空带，而超过 82px 的草稿又在框内滚动。
 * 现在高度按内容算一遍，最小是 CSS 的单行高度，最大是 CSS 的 max-height，超出才在框内滚动。
 * 上下限仍然只在 `src/styles.css` 的 `.composer textarea` 里定义一份，这里读计算后的样式。
 */
export const COMPOSER_TEXTAREA_MIN_HEIGHT = 48;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 132;

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
 * 量一次 textarea 的内容高度并把它设成实际高度，返回设进去的像素值。
 * 先设 `auto` 才能量到缩短后的内容高度，否则框只会长高不会变矮。
 */
export function fitComposerTextarea(textarea, { getStyles = (node) => getComputedStyle(node) } = {}) {
  if (!textarea) return 0;
  const styles = getStyles(textarea);
  const size = { minHeight: styles.minHeight, maxHeight: styles.maxHeight };
  textarea.style.height = 'auto';
  const height = composerTextareaHeight(textarea.scrollHeight, size);
  textarea.style.height = `${height}px`;
  return height;
}
