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
 * - 输入框永远贴着键盘上沿，中途也不脱开——上移量算的是「输入框静息底边到键盘上沿」那段，不是键盘高
 *   度。静息时输入框底边离屏幕底还留着 8px + 安全区（styles.css），那一段本来就不该走（`keyboardLift`）；
 * - 消息列表的窗口连内容一起动，没有任何一块被推出自己的裁剪框。上一版把消息列表单独 translate，收起
 *   键盘时它会整块滑出 `.message-region`，于是整片区域露出页面底色——用户报的「短暂黑屏」；
 * - 键盘抬起时这一层还向上多长一段（`--keyboard-lift`，也是落地时才写）：收起的那一段里，窗口上沿跟着
 *   往下走，多出来的这一段正好把上面的历史消息留在窗口里，而不是留一条空白（原生键盘收起时窗口是向上
 *   长的，看到的就是这些历史）。它和 `.detail-screen` 的 padding-bottom 在消息列表的高度上正好抵消：
 *   换手前后列表的可见高度一致，滚动位置不用动；
 * - 布局在运动期间一次都不动，所以没有缺口可以闪；
 * - 落地时把 transform 换回布局：给 `--keyboard-inset` 写一次键盘高度，`.detail-screen` 的 padding-bottom
 *   把这一层连同输入框抬到同一个位置，输入框的底部安全区边距同时归零（styles.css）；写布局、清 transform、
 *   消息列表贴底在同一个任务里完成，两者描述同一批像素，切换看不见。
 *
 * 落地的时刻取 `keyboardDidShow` / `keyboardDidHide`；时长与曲线是 iOS 自己的（250ms、curve 7 的近
 * 似，插件不向外暴露这两个值），差一点也会被落地事件纠正回来。
 */

/** 键盘占的高度，写在 `:root` 上供布局使用。 */
export const KEYBOARD_INSET_VAR = '--keyboard-inset';
/** 跟键盘走的那一层在键盘抬起时向上多长的一段，写在 `:root` 上供布局使用。 */
export const KEYBOARD_LIFT_VAR = '--keyboard-lift';
/** 与 `ScrollToBottomButton` 一致：离底不超过这个距离就算「看着最新消息」。 */
export const KEYBOARD_FOLLOW_SLACK = 96;
/** iOS 键盘动画时长；插件不暴露 `UIKeyboardAnimationDurationUserInfoKey`。 */
export const KEYBOARD_MOTION_MS = 250;
/** 事件丢了也不能把布局留在抬起的状态上：落地事件的兜底等待。 */
export const KEYBOARD_LANDING_GRACE_MS = 650;
/** curve 7 的近似，与滑退、下拉收敛用的是同一条曲线。 */
export const KEYBOARD_MOTION_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** 键盘运动期间挂在跟键盘走的那一层上：层内部的定时渐变/阴影在这 250ms 里停一停。 */
export const KEYBOARD_MOTION_CLASS = 'keyboard-moving';

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
  const gap = Number(restGap);
  return Math.max(0, keyboardInset(keyboardHeight) - (Number.isFinite(gap) ? Math.max(0, Math.round(gap)) : 0));
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

function animateTravel(element, from, to, duration) {
  return element.animate(
    [{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }],
    { duration, easing: KEYBOARD_MOTION_EASING, fill: 'both' },
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
  motionMs = KEYBOARD_MOTION_MS,
} = {}) {
  let inset = 0;
  // 输入框静息底边离屏幕底有多远。只有真正静息（布局没抬起、也没在动）时才重新量一次。
  let restGap = 0;
  let motion = null;
  let handles = [];
  let stopped = false;

  function writeInset(next) {
    inset = next;
    root.style.setProperty(KEYBOARD_INSET_VAR, `${next}px`);
  }

  // 长度与 inset 同一批写进去：两个布局值互相抵消，同一个任务里换，画面才对得上。
  function writeLift(next) {
    root.style.setProperty(KEYBOARD_LIFT_VAR, `${Math.max(0, next)}px`);
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

  function stopMotion() {
    const pending = motion;
    motion = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.animations.forEach((animation) => animation.cancel());
    pending.region?.classList.remove(KEYBOARD_MOTION_CLASS);
  }

  // 键盘落地、动画也走完，才把布局换过去：此时两者描述同一批像素，切换在视野里不存在。
  function settleMotion() {
    const pending = motion;
    if (!pending || !pending.landed || !pending.moved) return;
    motion = null;
    if (pending.timer) clearTimeout(pending.timer);
    writeInset(pending.target);
    writeLift(pending.settledLift);
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

  function land() {
    if (!motion) return;
    motion.landed = true;
    settleMotion();
  }

  function moveTo(target) {
    if (target === inset && !motion) return;
    const next = pieces();
    const scroller = next?.scroller || null;
    const geometry = geometryOf(scroller);
    if (next) measureRestGap(next);
    // 抬起来与收起走的是同一个量：键盘高度减输入框静息的那段空隙。
    const lift = keyboardLift({ keyboardHeight: Math.max(inset, target), restGap });
    const following = listTravels(geometry);
    const from = next && following ? translateYOf(readTransform(next.region)) : 0;
    const to = target > 0 ? -lift : lift;
    stopMotion();
    const pending = {
      target,
      settledLift: following && target > 0 ? lift : 0,
      region: next?.region || null,
      scroller,
      following,
      animations: [],
      landed: false,
      moved: false,
      timer: 0,
    };
    motion = pending;
    if (next) {
      if (following) next.region.classList.add(KEYBOARD_MOTION_CLASS);
      for (const element of following ? [next.region, next.dock] : [next.dock]) {
        const start = element === next.region ? from : translateYOf(readTransform(element));
        if (start !== to) pending.animations.push(animateTravel(element, start, to, motionMs));
      }
    }
    pending.moved = pending.animations.length === 0;
    settleMotion();
    pending.animations.forEach((animation) => {
      animation.finished.then(() => {
        if (motion !== pending) return;
        pending.moved = true;
        settleMotion();
      }, () => {});
    });
    pending.timer = setTimeout(() => {
      if (motion !== pending) return;
      pending.moved = true;
      pending.landed = true;
      settleMotion();
    }, motionMs + KEYBOARD_LANDING_GRACE_MS);
  }

  function raise(height) {
    const target = keyboardInset(height);
    // 只有 QuickType 提示栏的变动会被插件报成 0（`shouldIgnoreResizeForHeight`：不足屏幕高度的
    // 20% 就不算键盘）：键盘还在，布局就留在原地。真正收起只走 `keyboardWillHide`。
    if (!target) return;
    if (target === inset && !motion) return;
    moveTo(target);
  }

  // 落地事件自己带着高度：`willShow` 整个丢掉时直接落地，不补一段已经过时的动画。
  function raiseNow(height) {
    const target = keyboardInset(height);
    if (!target || target === inset) return;
    const next = pieces();
    if (next) measureRestGap(next);
    stopMotion();
    writeInset(target);
    writeLift(listTravels(geometryOf(next?.scroller)) ? keyboardLift({ keyboardHeight: target, restGap }) : 0);
  }

  function lower() {
    if (!inset && !motion) return;
    moveTo(0);
  }

  async function start() {
    if (stopped || !native) return stop;
    const events = [
      ['keyboardWillShow', (info) => raise(info?.keyboardHeight)],
      ['keyboardDidShow', (info) => {
        // 落地事件总是补齐信息：`willShow` 丢过一次也不会把布局留在没抬起的状态。
        if (motion) land();
        else raiseNow(info?.keyboardHeight);
      }],
      ['keyboardWillHide', () => lower()],
      ['keyboardDidHide', () => {
        if (motion) land();
        else if (inset) {
          writeInset(0);
          writeLift(0);
        }
      }],
    ];
    handles = await Promise.all(events.map(([event, handler]) => keyboard.addListener(event, handler)));
    if (stopped) stop();
    return stop;
  }

  function stop() {
    stopped = true;
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
