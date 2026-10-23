// 轻提示（toast）的分工契约。
//
// 用户的原话是「很多触发性质动作造成的提示应该改为 toast 而不是固定写死在页面」，
// 所以这里同时钉两遍：
//   - 动作反馈必须在 toast 层（页面里不再有那几行常驻文字）；
//   - 持续状态（断线、加载失败、桌面会话）不许被搬到 toast —— 会消失的提示不能承担状态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8');

test('toast 队列与桌面同一套语义：3 条上限、3.2 秒、同文案不叠第二条', async () => {
  const source = await read('src/toast.jsx');
  assert.match(source, /export const TOAST_STACK_LIMIT = 3;/);
  assert.match(source, /export const TOAST_LIFETIME_MS = 3200;/);
  assert.match(source, /export function useToasts\(\)/);
  assert.match(source, /export function ToastStack\(/);
  // 去重键是 kind + message：用户反复触发同一条提示时只续命，不叠一条新的。
  assert.match(source, /const key = `\$\{tone\}\\u0000\$\{text\}`;/);
  // 超限先丢最早到期的那条。
  assert.match(source, /if \(!victim \|\| entry\.expiresAt < victim\.expiresAt\)/);
  // 提示区不能抢手势：容器关掉 pointer-events，气泡只做普通块。
  const css = await read('src/styles.css');
  assert.match(css, /\.app-toast-stack \{[^}]*pointer-events: none;/);
  // 要压过详情页（50）、弹层（100）和输入区（40）；批注菜单（1700/1750）仍然在上——
  // 用户正拿着菜点选时，一次 toast 不该糊在它上面。
  assert.match(css, /\.app-toast-stack \{[^}]*z-index: 1600;/);
  assert.match(css, /\.app-toast-stack \{[^}]*top: calc\(12px \+ var\(--safe-top\)\)/);
});

test('动作类提示全部改走 toast，页面里不再常驻那几行字', async () => {
  const app = await read('src/App.jsx');
  assert.match(app, /const \{ toasts, pushToast \} = useToasts\(\);/);
  assert.match(app, /<ToastStack toasts=\{toasts\} \/>/);
  assert.match(app, /onToast=\{pushToast\}/);
  // 批注校验 / 批注落盘失败 / 图片校验失败 / 换会话名失败 / 相册打不开：都是动作反馈。
  assert.match(app, /if \(commentsError\) \{\n\s+pushToast\('error', commentsError\);/);
  assert.match(app, /if \(annotationStorageError\) pushToast\('error', annotationStorageError\);/);
  assert.match(app, /if \(firstImageError\) pushToast\('error', firstImageError\);/);
  assert.match(app, /pushToast\('error', renameError\.message\);/);
  assert.match(app, /pushToast\('error', nextError\?\.message \|\| 'Could not open the photo library\.'\);/);
  assert.match(app, /if \(running\) pushToast\('info', 'Comments are saved as a draft\. Send after the task finishes or stops\.'\);/);
  // 行内那几行字必须真的没了。
  assert.doesNotMatch(app, /haish-annotation-notice/);
  assert.doesNotMatch(app, /composer-image-error/);

  const settings = await read('src/settings-screen.jsx');
  assert.match(settings, /pushToast\('success', `Access revoked for \$\{name\}\.`\)/);
  assert.doesNotMatch(settings, /settings-notice/);

  const keyboard = await read('src/desktop-keyboard.jsx');
  assert.match(keyboard, /pushToast\('success', 'Sent to computer'\)/);
  assert.match(keyboard, /pushToast\('error', 'Not sent · draft kept'\)/);
  assert.doesNotMatch(keyboard, /setNotice/);
});

test('持续状态继续留在页面：断线横幅、加载失败卡片、桌面会话提示', async () => {
  const app = await read('src/App.jsx');
  // 连接/流中断仍然走错误条，不能改成会自动消失的 toast。
  assert.match(app, /detail-error-banner/);
  assert.match(app, /Couldn’t load this conversation/);
  assert.match(app, /setError\(notice\);/);
  const desktop = await read('src/remote-desktop.jsx');
  assert.match(desktop, /desktop-session-note/);
});

// 真机验收发现的：进程里一条都看不见的提示。
//
// 详情页盖住目录页时，目录那棵树的动画会被 `animation-play-state: paused` 冻住（省电，
// 也免得多余重绘）。提示栈跟目录是同一个父节点的兄弟，所以整条 `toast-in` 也被冻在
// 第一帧——`from { opacity: 0 }`，于是提示"弹"了但一直是全透明：iPhone 上点 Retry 被
// runtime 拒绝时，页面看起来什么都没发生，其实请求、错误文案、计时器全都跑了。
// 这里钉两件事：暂停规则必须把 `.app-toast-stack` 排除在外；入场动画仍然是那条从
// 透明起步的 keyframes（否则这条豁免就没有意义了）。
test('详情页打开时提示栈不被目录的暂停规则冻住', async () => {
  const css = await read('src/styles.css');
  assert.match(
    css,
    /\.app-shell\.detail-open > :not\(\.detail-screen\):not\(\.app-toast-stack\) \*,[\s\S]*?html\.detail-closing \.app-shell > :not\(\.detail-screen\):not\(\.app-toast-stack\) \* \{ animation-play-state: paused; \}/,
  );
  // 目录那棵树该暂停的照旧暂停（别为了提示把整条规则删了）。
  assert.match(css, /\.app-shell\.detail-open > :not\(\.detail-screen\) \{ pointer-events: none; \}/);
  assert.match(css, /\.app-toast \{[^}]*animation: toast-in 240ms ease-out;/);
  assert.match(css, /@keyframes toast-in \{ from \{ opacity: 0;/);
});
