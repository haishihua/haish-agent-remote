import { Keyboard } from '@capacitor/keyboard';

import { isNativeApp } from './native-connection.js';

/**
 * iOS 会在 WebView 里的输入框获得焦点时，于键盘上方压一条系统表单栏（「◀ ▶ Done」）。
 * 那条栏是系统给网页表单的，不属于本 App：它白占一行高度，把输入框和键盘隔开，点 Done 也只是收键盘
 * （本 App 点消息区就收）。Capacitor 官方的 Keyboard 插件负责这条栏，所以这里直接让它隐藏。
 *
 * 插件在 `capacitor.config.ts` 里被声明、并随 `packageClassList` 注册进包；注册缺失时这里的调用会
 * 直接失败，而不是悄悄留着那条栏。
 */
export async function hideKeyboardAccessoryBar({ keyboard = Keyboard, native = isNativeApp } = {}) {
  if (!native) return false;
  await keyboard.setAccessoryBarVisible({ isVisible: false });
  return true;
}

/**
 * 键盘和输入框一起走。
 *
 * Capacitor 的 Keyboard 插件本该负责「键盘弹出时缩短 WebView」（`resize: 'native'`），但它把这个动作
 * 排在了键盘动画之后：`onKeyboardWillShow:` 把键盘动画时长 +0.2 秒当作*延迟*，到点才一把 `setFrame:`
 * 到位，前后没有任何动画（ionic-team/capacitor-keyboard#79）。现场是键盘先升起来、压在还没让位的输入
 * 框上，约 0.4s 后整个页面才跳一下；收起时反过来：frame 先弹回全高，页面还停在缩短的高度上，底下的
 * 界面（这里是会话目录）从缺口里露出来。这两半都在原生插件里，所以插件被设成 `resize: 'none'`，键位由
 * 这一层跟。
 *
 * 跟的是两块一起走，而不是把消息列表的滚动内容单独 translate。详情里消息列表和输入框在键盘抬起时
 * 同步平移（App.jsx 把这两块交给控制器），输入框贴着键盘上沿，消息列表连窗口带内容一起动：
 *
 * - 只有读者贴着底端时才让消息列表跟着走：翻上去看历史时键盘只是盖住列表下缘，内容留在原处
 *   （ChatGPT 那种「只在贴着底时才抬」；Telegram/WhatsApp 是无条件抬），输入框照走不误；
 * - 输入框停在键盘上沿再往上 `KEYBOARD_DOCK_GAP`（12pt，照参考图量的那条线）上，中途也不脱开——上移量
 *   算的是「输入框静息底边到那条线」那段，不是键盘高度。静息时输入框底边离屏幕底还留着 8px + 安全区
 *   （styles.css），那一段本来就不该走（`keyboardLift`）；
 * - 消息列表的窗口连内容一起动，没有任何一块被推出自己的裁剪框。上一版把消息列表单独 translate，收起
 *   键盘时它会整块滑出 `.message-region`，于是整片区域露出页面底色——用户报的「短暂黑屏」；
 * - 键盘抬起时这一层还向上多长一段（`--keyboard-lift`，默认等到落地才写，见下一条例外）：收起的那一段里，窗口上沿跟着
 *   往下走，多出来的这一段正好让它留在页头上方，而不是在页头下面露出一条空白（原生键盘收起时窗口是向上
 *   长的，看到的就是这段历史）。它和 `.detail-screen` 的 padding-bottom 在消息列表的高度上正好抵消：
 *   换手前后列表的可见高度一致，滚动位置不用动；
 * - 抬多高必须和这一层当时的走向配平：读者贴着底（这一层要动画）时，布局里那段也得抬着。1.36 里这个配平
 *   是「落地时才写」，碰上「上一次抬起时读者没贴底（没抬）、这一次贴底（要动画）」这个组合，窗口就整块
 *   往下滑、页头下面露出一条键盘高、纯黑的缺口——用户反馈里的「短暂黑屏」。现在改成：一次「贴底」的收起
 *   一开始就把布局换到抬起状态（同一个任务里用滚动把内容按回原位，画面不动），而不是等到落地才换；
 * - 键盘抬着的时候高度又变了一次（换输入法、切 emoji、系统键盘上多一条提示栏）走的是「新旧高度之差」，
 *   不是整个上移量：布局里还抬着上一把键盘的那一段，再补一整段就是用户报的「切换键盘，输入框又往上跑」。
 *   换键盘在 iOS 上常常只发 `UIKeyboardWillChangeFrameNotification`，Capacitor 的插件只订阅 will/didShow
 *   与 will/didHide，所以原生 bridge controller 把这条通知里的高度原样转给这一层（`haishKeyboardFrame` 事件，
 *   见 ios/App/App/HaishBridgeViewController.swift）——插件一声不响时布局也不会留在上一把键盘的高度上；
 * - 布局在运动期间原则上不动（唯一一次例外是上面那种配平：同一个任务里换完，画面不动），所以没有缺口可以闪；
 * - 落地时把 transform 换回布局：给 `--keyboard-inset` 写一次键盘高度，`.detail-screen` 的 padding-bottom
 *   把这一层连同输入框抬到同一个位置，输入框的底部安全区边距同时归零（styles.css）；写布局、清 transform、
 *   消息列表贴底在同一个任务里完成，两者描述同一批像素，切换看不见。
 *
 * - WKWebView 自己那一层还会把整篇文档顶一下：插件在每个键盘事件里只把 `contentInset` 清回 0
 *   （`resetScrollView`），`contentOffset` 没人管，被顶走的那一段就留在画面里（顶上是页头、底下露一片页面底色）。
 *   两个落地事件里各把 `window.scrollY / scrollX` 按回 0 一次（`pinDocumentOffset`）：整页是个 `inset: 0`
 *   的固定壳，文档本来就不该滚动，没被顶走时一次也不碰；
 *
 * 这一层是从键盘自己的时间线上起步的：原生那条 frame 通道把通知发出的时刻（`at`，毫秒）一并带过来，动画
 * 用负的 delay 从「键盘已经走到的那一格」开始播（`keyboardElapsedMs`）。事件要穿过 bridge，还可能排在主
 * 线程上的重活后面（这一趟里正好有输入框自己的量高、IME 的 marked text），晚到多少就从进度里补回多少——
 * 用户报的「键盘已经上来，输入框还停在下面」就是这段差价：从事件到达才算 0 的那一版，前半趟整个躲在键盘
 * 后面，落地才被布局扳上去。落地兜底也按这条时间线排（`rebaseLandingTimer`）：键盘自己走完（`at` + 时长）
 * 的那一下换布局，而不是「我们收到事件之后时长 + 650ms 保险」——换键盘时 iOS 常常只发 will-change、没有
 * 落地事件，兜底晚 650ms 写下去，看到的就是界面上下跳一下。
 *
 * 落地的时刻取 `keyboardDidShow` / `keyboardDidHide`。时长与曲线都尽量取 iOS 自己的：曲线是 curve 7（一条
 * 无过冲的弹簧，起步快、收尾慢）的采样，时长由 AppDelegate 那条 frame 通道从
 * `UIKeyboardAnimationDurationUserInfoKey` 带过来（这两个值插件都不往外报）。之前那条
 * `cubic-bezier(0.32, 0.72, 0, 1)` 是下拉收敛用的，比键盘快得多——走到两成时它已经走完六成半，弹簧那时
 * 只有四成，现场就是输入框比键盘先到、中途甩开一段再被追上，也就是用户报的「拉起键盘和收起都不自然」。
 * 差一点由落地事件纠正回来。
 */

/** 键盘占的高度，写在 `:root` 上供布局使用。 */
export const KEYBOARD_INSET_VAR = '--keyboard-inset';
/** 跟键盘走的那一层在键盘抬起时向上多长的一段，写在 `:root` 上供布局使用。 */
export const KEYBOARD_LIFT_VAR = '--keyboard-lift';
/** 与 `ScrollToBottomButton` 一致：离底不超过这个距离就算「看着最新消息」。 */
export const KEYBOARD_FOLLOW_SLACK = 96;
/**
 * 输入框底边停在「键盘上沿再往上」这一段（12pt，照用户给的参考图 ChatGPT 量的）。输入框两侧本来就留 10px，
 * 底下也留一段，整块才是浮在键盘上，而不是长在键盘上。改这个数要同时改 styles.css 里 `.composer-dock` 的
 * 同名取值，两处必须一致，否则落地换手时输入框会跳。
 */
export const KEYBOARD_DOCK_GAP = 12;
/** iOS 键盘动画时长；插件不暴露 `UIKeyboardAnimationDurationUserInfoKey`，原生那条 frame 通道会把它带过来。 */
export const KEYBOARD_MOTION_MS = 250;
/** 原生报来的时长只在这个区间里认，免得某个版本报个离谱的值把动画拉长或压没。 */
export const KEYBOARD_MOTION_MS_RANGE = [100, 600];
/** 事件丢了也不能把布局留在抬起的状态上：落地事件的兜底等待。 */
export const KEYBOARD_LANDING_GRACE_MS = 650;
/**
 * curve 7（键盘那条曲线）是一条无过冲的弹簧：起步快、收尾慢、落在目标上不带弹跳。这里把临界阻尼弹簧
 * `x(u) = 1 - (1 + 7u)e^(-7u)` 采样成 `linear()`（21 个停靠点，误差 < 0.5%）。
 */
export const KEYBOARD_MOTION_EASING = 'linear(0, 0.04903 5%, 0.1569 10%, 0.2847 15%, 0.4112 20%, 0.526 25%, 0.6249 30%, 0.7074 35%, 0.7746 40%, 0.8282 45%, 0.8705 50%, 0.9034 55%, 0.9288 60%, 0.9483 65%, 0.9631 70%, 0.9743 75%, 0.9828 80%, 0.9891 85%, 0.9938 90%, 0.9974 95%, 1)';
/** 老 WebKit 不认 `linear()` 时的退路：同一条弹簧曲线的三次贝塞尔拟合（最大偏差 1.8%）。 */
export const KEYBOARD_MOTION_EASING_FALLBACK = 'cubic-bezier(0.3, 0.35, 0.15, 1)';
/** 键盘运动期间挂在跟键盘走的那一层上：层内部的定时渐变/阴影在这 250ms 里停一停。 */
export const KEYBOARD_MOTION_CLASS = 'keyboard-moving';
/**
 * AppDelegate 转发的键盘 frame 事件（`UIKeyboardWillChangeFrameNotification`）。
 *
 * `detail.height` 是键盘在屏幕上真正盖住的高度（点）；切换输入法时它可以瞬时为 0，所以只有来自独立
 * `UIKeyboardWillHideNotification` 的 `detail.dismissal` 才表示收起。`detail.duration` 是这一趟的动画时长
 * （秒，`UIKeyboardAnimationDurationUserInfoKey`，插件不报它）；`detail.at` 是通知发出的时刻（毫秒，与
 * `Date.now()` 同一把尺子），这一层用它把动画锚在键盘自己的时间线上（见 `keyboardElapsedMs`）。
 * 名字要和
 * ios/App/App/HaishBridgeViewController.swift 里的一致——构建会核原生与 Web 两端。
 */
export const KEYBOARD_FRAME_EVENT = 'haishKeyboardFrame';
/**
 * The native frame notification is dispatched in the same run-loop turn UIKit starts the keyboard.
 * When its height is zero (dismissal), compact the composer before starting the travel so Web and
 * keyboard never spend a frame in different visual states. App.jsx uses the same class on focus.
 */
export const KEYBOARD_COMPOSER_EXPANDED_CLASS = 'expanded';

/** 浏览器认不认这条 `linear()`：不认就用贝塞尔那条退路，别让整条动画掉回 linear。 */
export function keyboardMotionEasing({ supports = defaultSupportsEasing } = {}) {
  return supports(KEYBOARD_MOTION_EASING) ? KEYBOARD_MOTION_EASING : KEYBOARD_MOTION_EASING_FALLBACK;
}

function defaultSupportsEasing(value) {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  try {
    return CSS.supports('animation-timing-function', value);
  } catch {
    return false;
  }
}

/** 原生报的键盘动画时长（秒）换算成毫秒；没有或者离谱就沿用上一把键盘的值。 */
export function keyboardMotionMs(seconds, fallback = KEYBOARD_MOTION_MS) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const [min, max] = KEYBOARD_MOTION_MS_RANGE;
  return Math.min(max, Math.max(min, Math.round(value * 1000)));
}

/**
 * 键盘自己的动画已经走了多久（毫秒）：原生报来的那一刻（`at`，与 `Date.now()` 同一把尺子）到这一刻的差。
 *
 * 这一层拿到键盘高度的时候键盘往往已经在动了——通知要先穿过 bridge，再等 Web 进程的主线程空出来。晚到多少
 * 就得从进度里补回多少，否则动画从 0 起步，用户看到的就是「键盘已经上来，输入框还停在下面」。没带时刻、
 * 两边的钟对不上（负数）、时长为 0 都按没报算（0）；比整趟还久（事件晚到一步到位）按走完算——那时键盘已经
 * 到位，输入框就该一步到位。
 */
export function keyboardElapsedMs({ at = null, now = Date.now(), duration = KEYBOARD_MOTION_MS } = {}) {
  const startedAt = keyboardStartAt(at);
  const current = Number(now);
  const span = Number(duration);
  if (startedAt === null || !Number.isFinite(current) || !Number.isFinite(span) || span <= 0) return 0;
  const elapsed = current - startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(Math.round(span), Math.round(elapsed));
}

/** 原生报来的时刻（毫秒）：没带、或者不是个数就当没报（`null`）。 */
export function keyboardStartAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const at = Number(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 键盘要从布局里拿走多少高度：插件报的就是键盘 frame 的高度（已经包含它盖住的底部安全区，所以不扣）。
 */
export function keyboardInset(keyboardHeight) {
  const height = Number(keyboardHeight);
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, Math.round(height));
}

/**
 * 跟键盘走的那一层要上移多少：输入框静息底边离屏幕底 `restGap`（8px + 安全区），键盘上沿离屏幕底
 * `keyboardHeight`（插件报的高度已经包含底部安全区，两把尺子都是「离屏幕底多少」）。落地时布局把输入
 * 框放到 `keyboardHeight` 那个位置、静息时放在 `restGap`，所以这中间的差就是移动量。
 */
export function keyboardLift({ keyboardHeight = 0, restGap = 0 } = {}) {
  const height = keyboardInset(keyboardHeight);
  if (!height) return 0;
  const gap = Number(restGap);
  return Math.max(0, height + KEYBOARD_DOCK_GAP - (Number.isFinite(gap) ? Math.max(0, Math.round(gap)) : 0));
}

/**
 * 布局把输入框底边放在离屏幕底多远：键盘抬着时是键盘上沿再往下 `KEYBOARD_DOCK_GAP`（那一段不该走），静息时
 * 是输入框自己那段底边距。`moveTo` 的起止点都用这把尺子，动画跨过的才是真正要走的像素。
 */
function dockOffset(height, restGap) {
  const inset = keyboardInset(height);
  return inset > 0 ? inset + KEYBOARD_DOCK_GAP : restGap;
}

/**
 * 读者是不是贴着底（看着最新消息）：离底不超过 slack。`ScrollToBottomButton` 的吸底用的是同一条判断。
 */
export function keyboardFollowing({ contentHeight = 0, viewportHeight = 0, scrollTop = 0, slack = KEYBOARD_FOLLOW_SLACK } = {}) {
  return contentHeight - scrollTop - viewportHeight <= slack;
}

/** 读者贴着底端时消息列表才跟着键盘走；翻上去看历史时它留在原处（只有输入框让开）。 */
function listTravels(geometry) {
  return Boolean(geometry && keyboardFollowing(geometry));
}

/** 计算后的 transform 里的 Y 位移，让被打断的动画从当前位置接着走。 */
export function translateYOf(transform) {
  const parts = /matrix(?:3d)?\(([^)]*)\)/.exec(String(transform || ''));
  if (!parts) return 0;
  const values = parts[1].split(',').map((value) => Number.parseFloat(value));
  const y = values.length > 6 ? values[13] : values[5];
  return Number.isFinite(y) ? y : 0;
}

let keyboardSurface = null;

/** 正在动的控制器个数，见 `isKeyboardMoving`。 */
let movingControllers = 0;

/**
 * 键盘正在动（合成层上的动画还没落地）：轮询这类后台重活在这几百毫秒里让路——一份会话的解析与
 * 重渲染落进键盘动画里，看到的就是动画一顿一顿。与下拉手势的守卫放在同一处用（App.jsx）。
 */
export function isKeyboardMoving() {
  return movingControllers > 0;
}

/** 打开的会话把跟键盘一起移动的两块（消息列表、输入框）交给控制器，离开时收回。 */
export function registerKeyboardSurface(next) {
  keyboardSurface = next;
  return () => {
    if (keyboardSurface === next) keyboardSurface = null;
  };
}

/** 会话里的答案框在列表内部：浏览器自己那次滚动发生在布局挪动之前，落地后得再把它拉回输入框上方。 */
function revealFocusedField(scroller) {
  const active = scroller?.ownerDocument?.activeElement;
  if (!scroller || !active || !scroller.contains(active)) return;
  if (typeof active.scrollIntoView !== 'function') return;
  active.scrollIntoView({ block: 'nearest' });
}

/**
 * 位移铺到合成层上。`elapsed` 是键盘那一趟已经走过的时间：负的 delay 就是「从动画的这一格开始播」——
 * 键盘走到哪一格、这一层就从哪一格起步（没带时刻的调用方传 0，行为与逐帧同步的那一版一致）。
 */
function animateTravel(element, from, to, duration, easing, elapsed = 0) {
  return element.animate(
    [{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }],
    { duration, easing, fill: 'both', delay: elapsed > 0 ? -elapsed : 0 },
  );
}

export function createKeyboardInsetController({
  keyboard = Keyboard,
  native = isNativeApp,
  root = document.documentElement,
  getSurface = () => keyboardSurface,
  readTransform = (element) => window.getComputedStyle(element).transform,
  readRect = (element) => element.getBoundingClientRect(),
  readViewportHeight = () => window.innerHeight,
  viewport = typeof window === 'undefined' ? null : window,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
  // 落地兜底的定时器（见 `rebaseLandingTimer`）：测试换掉它就能读到这一趟排在什么时候。
  scheduleTimer = (callback, ms) => setTimeout(callback, ms),
  unscheduleTimer = (timer) => clearTimeout(timer),
  // 与原生报来的时刻对表的那把钟（`Date.now()`）：测试里可以喂一个确定的数。
  readClock = () => Date.now(),
  motionMs = KEYBOARD_MOTION_MS,
  supportsEasing = defaultSupportsEasing,
  setComposerExpanded = (dock, expanded) => dock?.querySelector?.('.composer')?.classList?.toggle(KEYBOARD_COMPOSER_EXPANDED_CLASS, expanded),
} = {}) {
  // 曲线一次定死（curve 7 是常量，只有认不认 `linear()` 这一件事），时长跟着原生报的走（`frame`）。
  const motionEasing = keyboardMotionEasing({ supports: supportsEasing });
  let durationMs = keyboardMotionMs(motionMs / 1000);
  let inset = 0;
  // 已经写进布局的 `--keyboard-lift`：换手时要知道「现在抬着多少」才能配平滚动位置。
  let liftValue = 0;
  // 输入框静息底边离屏幕底有多远。只有真正静息（布局没抬起、也没在动）时才重新量一次。
  let restGap = 0;
  let motion = null;
  let moving = false;
  let handles = [];
  let pendingFrame = null;
  let pendingFrameRequest = 0;
  let stopped = false;

  function writeInset(next) {
    inset = next;
    root.style.setProperty(KEYBOARD_INSET_VAR, `${next}px`);
  }

  // 长度与 inset 同一批写进去：两个布局值互相抵消，同一个任务里换，画面才对得上。
  function writeLift(next) {
    liftValue = Math.max(0, Math.round(Number(next) || 0));
    root.style.setProperty(KEYBOARD_LIFT_VAR, `${liftValue}px`);
  }

  /**
   * 落地时布局里该抬多少：只有「读者贴着底、而且键盘还抬着」时才抬，抬的是新键盘上沿减去输入框静息的
   * 那段空隙。连着动画换手的那一趟（`moveTo`）和落地事件补上丢掉的开场那一趟（`raiseNow`）落到的都是这个值。
   */
  function settledLiftFor(target, following) {
    return following && target > 0 ? keyboardLift({ keyboardHeight: target, restGap }) : 0;
  }

  function pieces() {
    const registered = getSurface?.();
    const region = registered?.regionRef?.current;
    const scroller = registered?.scrollerRef?.current;
    const dock = registered?.dockRef?.current;
    return region && scroller && dock ? { region, scroller, dock } : null;
  }

  function measureRestGap({ dock }) {
    if (inset || motion) return restGap;
    const bottom = readRect(dock)?.bottom;
    const viewport = readViewportHeight();
    if (!Number.isFinite(bottom) || !Number.isFinite(viewport)) return restGap;
    restGap = Math.max(0, Math.round(viewport - bottom));
    return restGap;
  }

  function geometryOf(scroller) {
    return scroller
      ? {
        contentHeight: scroller.scrollHeight,
        viewportHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
      }
      : null;
  }

  // 有动画在合成层上跑的时候整页得知道（那条键盘 motion 的守卫）：`moving` 与模块级计数同进同出。
  function setMoving(active) {
    if (moving === active) return;
    moving = active;
    movingControllers += active ? 1 : -1;
  }

  function stopMotion() {
    const pending = motion;
    motion = null;
    setMoving(false);
    if (!pending) return;
    if (pending.timer) unscheduleTimer(pending.timer);
    pending.animations.forEach((animation) => animation.cancel());
    pending.region?.classList.remove(KEYBOARD_MOTION_CLASS);
  }

  // 键盘落地、动画也走完，才把布局换过去：此时两者描述同一批像素，切换在视野里不存在。
  function settleMotion() {
    const pending = motion;
    if (!pending || !pending.landed || !pending.moved) return;
    motion = null;
    setMoving(false);
    if (pending.timer) unscheduleTimer(pending.timer);
    writeInset(pending.target);
    writeLift(pending.settledLift);
    keepView({
      scroller: pending.scroller,
      liftFrom: pending.liftAtStart,
      liftTo: pending.settledLift,
      transform: pending.traveledTo,
    });
    pending.animations.forEach((animation) => animation.cancel());
    pending.region?.classList.remove(KEYBOARD_MOTION_CLASS);
    pinToBottom(pending);
    revealFocusedField(pending.scroller);
  }

  /**
   * 换手的那一步自己把消息列表贴回底部：`ScrollToBottomButton` 的 ResizeObserver 要等到这一帧的渲染步骤才
   * 跑，而画面不该依赖那一步与清 transform 的先后。写的是同一个落点，所以它随后那次吸底是同一件事（幂等）；
   * 读者已经翻上去看历史时两边都不动。换手前后这一层的内部几何是同一套（抬起来的是 padding、内缩的是输
   * 入框自己的边距），所以这一步通常什么也没改。
   */
  function pinToBottom({ scroller, following }) {
    if (!scroller || !following) return;
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  /**
   * 布局里那段负 margin 每变一次，窗口上沿就整体挪一截（抬起来是向上长，收回是向下长：两种情况下内容
   * 在窗口里的位置都不变）。但滚动位置是相对窗口顶端的，不补就会跟着跳一下——翻上去看历史的人每次开合
   * 键盘都会看到内容平移一截。补的量正好抵消：窗口（布局）动多少、动画又另外动了多少，滚动就反着补多少。
   * 只有「读者贴着底」那一类是例外：他要的就是内容跟着键盘走，那一步是 `pinToBottom` 的事。
   */
  function keepView({ scroller, liftFrom, liftTo, transform }) {
    if (!scroller) return;
    const delta = (liftFrom - liftTo) - transform;
    if (!delta) return;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }

  function land() {
    if (!motion) return;
    motion.landed = true;
    settleMotion();
  }

  /**
   * 键盘这件事在 iOS 上分两层：这一层管布局，WKWebView 自己那一层还会把整篇文档往上顶一下——插件在键盘
   * 动画结束后只把 `contentInset` 清回 0（`resetScrollView`），`contentOffset` 不管；被顶走的那一段就留在
   * 画面里（顶上是页头、底下露一片页面底色），也就是用户报的「短暂黑屏」。这里只读 `window.scrollY`：被
   * 顶走了就按回 0。整页是个 `inset: 0` 的固定壳，文档本来就不该滚动（滚动都在 `.message-scroll`、`.list`
   * 这些内层容器里），按回去不会跟任何东西打架。
   */
  function pinDocumentOffset() {
    if (!viewport || typeof viewport.scrollTo !== 'function') return;
    if (!viewport.scrollY && !viewport.scrollX) return;
    viewport.scrollTo(0, 0);
  }

  function moveTo(target, { startedAt = null, now = readClock() } = {}) {
    if (target === inset && !motion) return;
    const next = pieces();
    const scroller = next?.scroller || null;
    const geometry = geometryOf(scroller);
    if (next) measureRestGap(next);
    // 布局现在把输入框放在哪：键盘抬着时是键盘上沿再往上 `KEYBOARD_DOCK_GAP`，静息时是它自己那段底边距。
    const from = dockOffset(inset, restGap);
    // 目标：新键盘上沿再往上同样一段；`target` 为 0（收起）就是静息位。
    const to = dockOffset(target, restGap);
    // 要补的是两者之差。键盘还抬着的时候高度又变了一次时，布局里已经抬着上一把键盘的那一段，
    // 再补一整段就是「输入框又往上跑」；布局和动画在落地那一刻描述同一批像素，差值才对。
    const travel = from - to;
    const following = listTravels(geometry);
    const start = next && following ? translateYOf(readTransform(next.region)) : 0;
    const settledLift = settledLiftFor(target, following);
    // 键盘那一趟已经走了多久：原生那条 frame 通道带着它开始的时刻（`at`）。事件晚到多少，动画就从键盘
    // 此刻所在的进度起步，而不是从零重走一遍。
    const started = keyboardStartAt(startedAt);
    const elapsed = keyboardElapsedMs({ at: started, now, duration: durationMs });
    // 两块各自现在停在哪一格先读出来（读的是动画正跑到的地方）：打断、换手都从这里接着走。
    const travelers = [];
    if (next && following) travelers.push(next.region);
    if (next) travelers.push(next.dock);
    const travels = travelers
      .map((element) => ({ element, from: translateYOf(readTransform(element)) }))
      .filter((item) => item.from !== travel)
      .map((item) => ({ ...item, to: travel }));
    stopMotion();
    // 往下走的那一趟（收起，或者换上一把更矮的键盘）里窗口上沿会跟着往下滑：布局里那段负 margin 必须
    // 同时抬着，窗口上沿才留在页头上方。「上一次抬起时读者没贴底（布局里没抬）、这一次贴底（要动画）」
    // 只有这个组合会出事：窗口整块滑下来，页头下面露出一条键盘高、纯黑的缺口。同一个任务里把布局换过去、
    // 再用滚动把内容按回原位，画面不动。往上走的一趟不用：多出来的那一段本来就藏在页头后面。
    let liftAtStart = liftValue;
    if (following && travel > 0 && liftAtStart < travel) {
      writeLift(travel);
      keepView({ scroller, liftFrom: liftAtStart, liftTo: travel, transform: start });
      liftAtStart = travel;
    }
    const pending = {
      target,
      settledLift,
      liftAtStart,
      // 只有消息列表真的在动画时窗口才动过；否则要补的全在布局那一段上。
      traveledTo: following ? travel : 0,
      region: next?.region || null,
      scroller,
      following,
      travels,
      animations: [],
      startedAt: started,
      elapsed,
      // 事件晚到一步到位（键盘那边已经走完了）：这一趟剩下的就是把布局换过去。
      landed: started !== null && elapsed >= durationMs,
      moved: false,
      timer: 0,
    };
    motion = pending;
    if (next && following) next.region.classList.add(KEYBOARD_MOTION_CLASS);
    playTravels(pending);
    setMoving(!pending.moved);
    settleMotion();
    rebaseLandingTimer(pending);
  }

  /**
   * 把这一趟的位移铺到合成层上。`pending.elapsed`（键盘那边已经走过的时间）交给 `animateTravel` 的负
   * delay：键盘走到哪一格、这一层就从哪一格起步。`fromLive` 是「从元素此刻所在的像素重新铺一次」
   * （见 `reanchor`：后到的时刻把已经在走的那一趟重新锚一次）。
   */
  function playTravels(pending, { fromLive = false } = {}) {
    pending.animations = pending.travels.map((item) => {
      const startY = fromLive ? translateYOf(readTransform(item.element)) : item.from;
      const animation = animateTravel(item.element, startY, item.to, durationMs, motionEasing, pending.elapsed);
      animation.finished.then(() => {
        // 已经被新的一趟换掉的那些（cancelled）不再算「走完」。
        if (motion !== pending || !pending.animations.includes(animation)) return;
        pending.moved = true;
        settleMotion();
      }, () => {});
      return animation;
    });
    pending.moved = pending.animations.length === 0;
    return pending.animations;
  }

  /**
   * 落地兜底：`keyboardDidShow` / `keyboardDidHide` 一次都不来（换键盘时 iOS 常常只发 will-change）时
   * 也得把布局换过去。这条定时器按键盘自己的时间线排：它已经走过 `pending.elapsed` 了，这一趟剩下的就只有
   * `时长 - elapsed`，再加一段「事件可能还在路上」的保险。从事件到达重新数一遍（旧行为）会让换键盘时的
   * 布局晚 650ms 才写下去，看到的正好是界面上下跳一下。
   */
  function rebaseLandingTimer(pending) {
    if (pending.timer) unscheduleTimer(pending.timer);
    const remaining = Math.max(0, durationMs - pending.elapsed) + KEYBOARD_LANDING_GRACE_MS;
    pending.timer = scheduleTimer(() => {
      if (motion !== pending) return;
      pending.moved = true;
      pending.landed = true;
      settleMotion();
    }, remaining);
  }

  /**
   * 插件的事件和原生那条 frame 通道会在同一轮里先后到达：先到的如果是插件（没有时刻），动画就已经从 0
   * 起步了。后到的那条带着时刻——把这一趟重新铺一次，从键盘此刻的进度接着走，别把已经走完的那段再演一遍。
   */
  function reanchor(startedAt) {
    const pending = motion;
    const started = keyboardStartAt(startedAt);
    if (!pending || started === null || pending.startedAt !== null || !pending.travels.length) return false;
    const elapsed = keyboardElapsedMs({ at: started, now: readClock(), duration: durationMs });
    if (elapsed <= 0) return false;
    pending.startedAt = started;
    pending.elapsed = elapsed;
    pending.animations.forEach((animation) => animation.cancel());
    playTravels(pending, { fromLive: true });
    // 键盘那边已经走完（事件晚得离谱）：这一趟剩下的就是把布局换过去。
    if (elapsed >= durationMs) pending.landed = true;
    setMoving(!pending.moved);
    rebaseLandingTimer(pending);
    settleMotion();
    return true;
  }

  function raise(height, startedAt = null) {
    const target = keyboardInset(height);
    // 只有 QuickType 提示栏的变动会被插件报成 0（`shouldIgnoreResizeForHeight`：不足屏幕高度的
    // 20% 就不算键盘）：键盘还在，布局就留在原地。真正收起只走 `keyboardWillHide`。
    if (!target) return;
    if (target === inset && !motion) return;
    // 已经在往同一个高度走了：插件的事件和 AppDelegate 转发的 frame 会撞在一起，别把动画重开一遍；
    // 后到的那条如果带着键盘那一刻的时刻，就把这一趟重新锚一次（`reanchor`）。
    if (motion && motion.target === target) {
      reanchor(startedAt);
      return;
    }
    moveTo(target, { startedAt });
  }

  /**
   * 原生 bridge controller 转发的键盘 frame：键盘类型切换（系统键盘 ↔ 第三方输入法、emoji、多一条提示栏）在 iOS 上
   * 常常只发 `UIKeyboardWillChangeFrameNotification`，插件订阅的 will/didShow 不会来，布局里就会留着上一把
   * 键盘的高度——用户报的「切换键盘，输入框又往上跑」。高度交给同一套逻辑；切换过程里的瞬时 0 高度忽略，
   * 只有原生独立转发的 `keyboardWillHide`（`detail.dismissal`）才表示键盘真的离场。
   */
  function compactComposer() {
    setComposerExpanded(pieces()?.dock, false);
  }

  function cancelPendingFrame() {
    if (pendingFrameRequest) cancelFrame(pendingFrameRequest);
    pendingFrameRequest = 0;
    pendingFrame = null;
  }

  function flushKeyboardFrame() {
    pendingFrameRequest = 0;
    const next = pendingFrame;
    pendingFrame = null;
    if (next) raise(next.height, next.at);
  }

  function onKeyboardFrame(event) {
    const detail = event?.detail || {};
    // Remember duration synchronously so a duplicate Capacitor will-show event in this turn uses
    // UIKit's value even though the geometry work below waits until the next paint.
    durationMs = keyboardMotionMs(detail.duration, durationMs);
    const height = keyboardInset(detail.height);
    if (detail.dismissal) {
      // A dedicated keyboardWillHide notification is the only zero frame that means dismissal.
      // Input-method switches and floating keyboards can transiently report zero while the same
      // textarea remains first responder; collapsing there moves both the editor and its caret.
      cancelPendingFrame();
      compactComposer();
      lower(detail.at);
      return;
    }
    if (!height) return;
    // UIKit can report several intermediate frames while changing input methods. Starting and
    // cancelling a Web Animation for every callback forces transform/layout reads on the main
    // thread. Keep only the newest positive target for this display frame.
    pendingFrame = { height, at: detail.at };
    if (!pendingFrameRequest) {
      // The real requestAnimationFrame is asynchronous; keeping this sentinel also makes injected
      // synchronous schedulers preserve the same state transition in unit tests.
      pendingFrameRequest = -1;
      const frameRequest = requestFrame(flushKeyboardFrame);
      if (pendingFrameRequest === -1) pendingFrameRequest = frameRequest;
    }
  }

  // 落地事件自己带着高度：`willShow` 整个丢掉时直接落地，不补一段已经过时的动画。
  function raiseNow(height) {
    const target = keyboardInset(height);
    if (!target || target === inset) return;
    const next = pieces();
    if (next) measureRestGap(next);
    stopMotion();
    const travels = listTravels(geometryOf(next?.scroller));
    writeInset(target);
    writeLift(settledLiftFor(target, travels));
    pinToBottom({ scroller: next?.scroller || null, following: travels });
  }

  function lower(startedAt = null) {
    if (!inset && !motion) return;
    if (motion && motion.target === 0) {
      reanchor(startedAt);
      return;
    }
    moveTo(0, { startedAt });
  }

  async function start() {
    if (stopped || !native) return stop;
    // 原生 controller 只负责同步报高度，怎么动由这一层决定（浏览器里没有这个事件，也就不会有监听）。
    viewport?.addEventListener?.(KEYBOARD_FRAME_EVENT, onKeyboardFrame);
    const events = [
      ['keyboardWillShow', (info) => raise(info?.keyboardHeight)],
      ['keyboardDidShow', (info) => {
        // 落地事件总是补齐信息：`willShow` 丢过一次也不会把布局留在没抬起的状态。
        if (motion) land();
        else raiseNow(info?.keyboardHeight);
        pinDocumentOffset();
      }],
      ['keyboardWillHide', () => {
        cancelPendingFrame();
        compactComposer();
        lower();
      }],
      ['keyboardDidHide', () => {
        if (motion) land();
        else if (inset) {
          const liftFrom = liftValue;
          const scroller = pieces()?.scroller || null;
          const follows = listTravels(geometryOf(scroller));
          writeInset(0);
          writeLift(0);
          keepView({ scroller, liftFrom, liftTo: 0, transform: 0 });
          pinToBottom({ scroller, following: follows });
        }
        pinDocumentOffset();
      }],
    ];
    handles = await Promise.all(events.map(([event, handler]) => keyboard.addListener(event, handler)));
    if (stopped) stop();
    return stop;
  }

  function stop() {
    stopped = true;
    viewport?.removeEventListener?.(KEYBOARD_FRAME_EVENT, onKeyboardFrame);
    cancelPendingFrame();
    const active = handles;
    handles = [];
    active.forEach((handle) => handle?.remove?.());
    stopMotion();
  }

  return { start, stop };
}

/** App 根部挂一次：键盘由它跟着走，布局变量也由它维护。 */
export function mountKeyboardInset(options = {}) {
  const controller = createKeyboardInsetController(options);
  controller.start();
  return () => controller.stop();
}
