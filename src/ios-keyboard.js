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
 * 这一层跟：
 *
 * - 布局只在一件事上听键盘的：键盘落地后给 `--keyboard-inset` 写一次「键盘占掉的高度」。这是输入框停
 *   靠的位置，也是目录页把自己的最后一行滑到键盘上方需要的那点空间（`body` 与 `.detail-screen` 各自
 *   消费这个变量，输入框的底部安全区边距同时归零，见 styles.css）；
 * - 运动全程不碰布局：输入框和消息列表按合成层上的 transform 跟键盘一起走，理由与滑退、下拉一样——
 *   逐帧写样式或重排会把整份消息列表算一遍，而这个 App 的主线程经常有活干；
 * - 布局的那一次切换发生在键盘落地的同一帧、紧挨着清掉 transform：两者描述的是同一批像素，所以切换
 *   看不见；消息列表自己的吸底（`ScrollToBottomButton` 的 ResizeObserver）也落在这一帧里；
 * - 展开键盘时布局一次都不动，所以没有任何东西可以闪：闪的根源是视口高度和页面高度不同步，现在高度
 *   不再随键盘变。
 *
 * 落地的时刻取 `keyboardDidShow` / `keyboardDidHide`；时长与曲线是 iOS 自己的（250ms、curve 7 的近
 * 似，插件不向外暴露这两个值），差一点也会被落地事件纠正回来。
 */

/** 键盘占的高度，写在 `:root` 上供布局使用。 */
export const KEYBOARD_INSET_VAR = '--keyboard-inset';
/** 与 `ScrollToBottomButton` 一致：离底不超过这个距离就算「看着最新消息」。 */
export const KEYBOARD_FOLLOW_SLACK = 96;
/** iOS 键盘动画时长；插件不暴露 `UIKeyboardAnimationDurationUserInfoKey`。 */
export const KEYBOARD_MOTION_MS = 250;
/** 事件丢了也不能把布局留在抬起的状态上：落地事件的兜底等待。 */
export const KEYBOARD_LANDING_GRACE_MS = 650;
/** curve 7 的近似，与滑退、下拉收敛用的是同一条曲线。 */
export const KEYBOARD_MOTION_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * 键盘要从布局里拿走多少高度：插件报的就是键盘 frame 的高度（已经包含它盖住的底部安全区，所以不扣）。
 */
export function keyboardInset(keyboardHeight) {
  const height = Number(keyboardHeight);
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, Math.round(height));
}

/**
 * 布局落下之后，消息列表自己的吸底会把 scrollTop 放到哪里——和 `ScrollToBottomButton`
 * （`scrollTop = scrollHeight`，由浏览器夹回上限）算的是同一个值，这正是动画与落地互换能对齐的原因。
 */
export function keyboardLanding({ contentHeight = 0, viewportHeight = 0, scrollTop = 0, inset = 0, following = true } = {}) {
  if (!following) return scrollTop;
  return Math.max(0, contentHeight - (viewportHeight - inset));
}

/**
 * 读者是不是贴着底（看着最新消息）：离底不超过 slack。`ScrollToBottomButton` 的吸底用的是同一条判断。
 */
export function keyboardFollowing({ contentHeight = 0, viewportHeight = 0, scrollTop = 0, slack = KEYBOARD_FOLLOW_SLACK } = {}) {
  return contentHeight - scrollTop - viewportHeight <= slack;
}

/**
 * 键盘移动期间各自要走多少像素：`composer` 是输入框那一叠的，`thread` 是消息列表的。
 * `inset` 是布局上等着发生的变化——键盘拿走高度时为正（展开），还回来时为负（收起）。
 */
export function keyboardTravel({ contentHeight = 0, viewportHeight = 0, scrollTop = 0, inset = 0, slack = KEYBOARD_FOLLOW_SLACK } = {}) {
  const travel = { composer: -inset, thread: 0 };
  // 读者已经滚上去看历史：列表留在原地，只有它自己的滚动位置能决定它跟不跟。
  if (!keyboardFollowing({ contentHeight, viewportHeight, scrollTop, slack })) return travel;
  travel.thread = scrollTop - keyboardLanding({ contentHeight, viewportHeight, scrollTop, inset, following: true });
  return travel;
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

/** 打开的会话把两个跟键盘走的部分交给控制器，离开时收回。 */
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
    [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
    { duration, easing: KEYBOARD_MOTION_EASING, fill: 'both' },
  );
}

export function createKeyboardInsetController({
  keyboard = Keyboard,
  native = isNativeApp,
  root = document.documentElement,
  getSurface = () => keyboardSurface,
  readTransform = (element) => window.getComputedStyle(element).transform,
  motionMs = KEYBOARD_MOTION_MS,
} = {}) {
  let inset = 0;
  let motion = null;
  let handles = [];
  let stopped = false;

  function writeInset(next) {
    inset = next;
    root.style.setProperty(KEYBOARD_INSET_VAR, `${next}px`);
  }

  function pieces() {
    const registered = getSurface?.();
    const scroller = registered?.scrollerRef?.current;
    const dock = registered?.dockRef?.current;
    return scroller && dock ? { scroller, dock } : null;
  }

  function stopMotion() {
    const pending = motion;
    motion = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.animations.forEach((animation) => animation.cancel());
  }

  // 键盘落地、动画也走完，才把布局换过去：此时两者描述同一批像素，切换在视野里不存在。
  function settleMotion() {
    const pending = motion;
    if (!pending || !pending.landed || !pending.moved) return;
    motion = null;
    if (pending.timer) clearTimeout(pending.timer);
    writeInset(pending.target);
    pending.animations.forEach((animation) => animation.cancel());
    pinToBottom(pending);
    revealFocusedField(pending.scroller);
  }

  /**
   * 换手的那一步自己把消息列表贴回底部：`ScrollToBottomButton` 的 ResizeObserver 要等到这一帧的渲染步骤才
   * 跑，而画面不该依赖那一步与清 transform 的先后。写的是同一个落点，所以它随后那次吸底是同一件事（幂等）；
   * 读者已经翻上去看历史时两边都不动。
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
    const geometry = scroller
      ? {
        contentHeight: scroller.scrollHeight,
        viewportHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
      }
      : null;
    const from = next
      ? {
        dock: translateYOf(readTransform(next.dock)),
        thread: translateYOf(readTransform(next.scroller)),
      }
      : null;
    const travel = geometry ? keyboardTravel({ ...geometry, inset: target - inset }) : null;
    stopMotion();
    const pending = {
      target,
      scroller,
      following: Boolean(geometry && keyboardFollowing(geometry)),
      animations: [],
      landed: false,
      moved: false,
      timer: 0,
    };
    motion = pending;
    if (next && from && travel) {
      if (from.dock !== travel.composer) pending.animations.push(animateTravel(next.dock, from.dock, travel.composer, motionMs));
      if (travel.thread && from.thread !== travel.thread) pending.animations.push(animateTravel(next.scroller, from.thread, travel.thread, motionMs));
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
    stopMotion();
    writeInset(target);
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
        else if (inset) writeInset(0);
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
