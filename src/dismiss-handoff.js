/**
 * 详情页收起时的「帧交接」。
 *
 * 收起那一帧上挤着三笔重活：React 卸掉整棵详情树（以及它那一串 effect 清理）、目录几十个定时动画重新
 * 交给合成器、顶栏第一次渲染 `backdrop-filter`（一整屏背景模糊）。挤在同一帧里，滑退动画的最后一下
 * 就是一次掉帧——用户报的「往右滑到最右边时卡一下」。
 *
 * 这里做的只是排期，不碰 DOM：动画最后那一帧先画出去，再卸层；目录那一头在卸掉之后再挂两帧
 * `detail-closing`（styles.css 里「先别恢复」的那组规则）才松开。`raf` 可注入，方便单测。
 *
 * 收起动作可能重叠（连点两次返回、或滑退动画和返回键撞上）：用一个计数保证 hold 只在最后一个动作
 * 结束时才摘掉。
 */

/** 挂在 `<html>` 上：目录的定时动画与顶栏模糊在这两帧里先别恢复。挂在 `<html>` 而不是 `.app-shell`：
 * 收起时 React 会重写 `.app-shell` 的 className（去掉 `detail-open`），命令式加的类会被它一起抹掉。 */
export const DIRECTORY_HOLD_CLASS = 'detail-closing';

/** 等到下一帧真的画出去之后（两个 rAF）再执行。 */
export function afterPaint(run, { raf = (callback) => requestAnimationFrame(callback) } = {}) {
  return raf(() => raf(run));
}

/**
 * 生成一次「收起详情页」的动作：先扶着目录不动，画完当前帧再卸详情层，卸完再画一帧才让目录恢复。
 */
export function createDismissHandoff({
  addHold = () => {},
  removeHold = () => {},
  unmount = () => {},
  raf,
} = {}) {
  let held = 0;
  return function dismiss() {
    held += 1;
    addHold();
    afterPaint(() => {
      unmount();
      afterPaint(() => {
        held -= 1;
        if (!held) removeHold();
      }, { raf });
    }, { raf });
  };
}
