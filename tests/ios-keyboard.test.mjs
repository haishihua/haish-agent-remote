import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKeyboardInsetController,
  hideKeyboardAccessoryBar,
  KEYBOARD_FRAME_EVENT,
  KEYBOARD_INSET_VAR,
  KEYBOARD_LIFT_VAR,
  KEYBOARD_MOTION_CLASS,
  KEYBOARD_MOTION_EASING,
  keyboardFollowing,
  keyboardInset,
  keyboardLift,
  mountKeyboardInset,
  registerKeyboardSurface,
  translateYOf,
} from '../src/ios-keyboard.js';

test('the accessory bar is hidden through the plugin, and the browser is left alone', async () => {
  const calls = [];
  const hidden = await hideKeyboardAccessoryBar({
    native: true,
    keyboard: { setAccessoryBarVisible: async (options) => calls.push(options) },
  });
  assert.equal(hidden, true);
  assert.deepEqual(calls, [{ isVisible: false }]);

  calls.length = 0;
  const skipped = await hideKeyboardAccessoryBar({
    native: false,
    keyboard: { setAccessoryBarVisible: async (options) => calls.push(options) },
  });
  assert.equal(skipped, false);
  assert.deepEqual(calls, []);
});

test('a rejected plugin call is not swallowed', async () => {
  const keyboard = { setAccessoryBarVisible: async () => { throw new Error('UNIMPLEMENTED'); } };
  await assert.rejects(hideKeyboardAccessoryBar({ keyboard, native: true }), /UNIMPLEMENTED/);
});

test('the inset is the keyboard frame height, rounded and never negative', () => {
  assert.equal(keyboardInset(336), 336);
  assert.equal(keyboardInset(336.4), 336);
  assert.equal(keyboardInset(-12), 0);
  assert.equal(keyboardInset(undefined), 0);
  assert.equal(keyboardInset('291'), 291);
});

test('a reader within the slack of the bottom is following the thread', () => {
  assert.equal(keyboardFollowing({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 }), true);
  assert.equal(keyboardFollowing({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3015 }), false);
});

test('the lift is the gap between where the composer rests and where the keyboard lands', () => {
  // 852 高的屏幕、键盘 336、输入框静息时离底 42（8px + 安全区）：走 294。
  assert.equal(keyboardLift({ keyboardHeight: 336, restGap: 42 }), 294);
  // 没有安全区（或量不到）时退化成整个键盘高度。
  assert.equal(keyboardLift({ keyboardHeight: 336, restGap: 0 }), 336);
  // 键盘比输入框静息的那段空隙还矮：不动，免得把输入框推到键盘下面。
  assert.equal(keyboardLift({ keyboardHeight: 20, restGap: 42 }), 0);
  assert.equal(keyboardLift({ keyboardHeight: 336, restGap: -5 }), 336);
  assert.equal(keyboardLift({}), 0);
});

test('the lift is exactly the distance that keeps the composer on the same pixel across the handoff', () => {
  // 静息：输入框底边 = 屏高 - restGap。落地后布局把它放在 屏高 - keyboardHeight。
  // 动画走 lift 之后，两个位置必须重合，否则换手时输入框会跳。
  const viewport = 852;
  for (const gap of [0, 8, 42, 68]) {
    for (const keyboardHeight of [0, 20, 291, 336, 367]) {
      const lift = keyboardLift({ keyboardHeight, restGap: gap });
      const animating = viewport - gap - lift;
      const landed = viewport - keyboardInset(keyboardHeight);
      if (keyboardInset(keyboardHeight) >= gap) assert.equal(animating, landed);
      else assert.equal(animating, viewport - gap);
    }
  }
});

test('a transform in flight is read back so an interrupted motion continues from where it is', () => {
  assert.equal(translateYOf('matrix(1, 0, 0, 1, 0, -294)'), -294);
  assert.equal(translateYOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 120.5, 0, 1)'), 120.5);
  assert.equal(translateYOf('none'), 0);
  assert.equal(translateYOf(undefined), 0);
});

test('the surface is handed over by the open conversation and taken back when it closes', () => {
  const target = { regionRef: { current: {} }, scrollerRef: { current: {} }, dockRef: { current: {} } };
  const release = registerKeyboardSurface(target);
  release();
  assert.equal(typeof release, 'function');
});

function fakeTraveler() {
  const classes = new Set();
  const animations = [];
  return {
    transform: 'none',
    classes,
    animations,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    animate(keyframes, options) {
      const animation = {
        keyframes,
        options,
        cancelled: false,
        finished: Promise.resolve(),
        cancel() { animation.cancelled = true; },
      };
      animations.push(animation);
      return animation;
    },
  };
}

function fakeDock({ bottom = 810 } = {}) {
  // 输入框那一叠也是会跟键盘移动的一块：除了位置，它和消息列表一样可以提供当前位移。
  return { ...fakeTraveler(), bottom };
}

function fakeScroll({ contentHeight = 0, viewportHeight = 0, scrollTop = 0 } = {}) {
  return {
    scrollHeight: contentHeight,
    clientHeight: viewportHeight,
    scrollTop,
    ownerDocument: { activeElement: null },
    contains: () => false,
  };
}

/** AppDelegate 转发键盘 frame 的那条通道：`haishKeyboardFrame` 事件。 */
function fakeViewport() {
  const handlers = new Map();
  const listening = [];
  return {
    listening,
    addEventListener(name, handler) {
      handlers.set(name, handler);
      listening.push(name);
    },
    removeEventListener(name) {
      handlers.delete(name);
      const at = listening.indexOf(name);
      if (at >= 0) listening.splice(at, 1);
    },
    dispatch(name, event) {
      handlers.get(name)?.(event);
    },
  };
}

function controllerFor({ region, dock, scroller, viewportHeight = 852, listeners = new Map(), writes = [], viewport = null }) {
  const controller = createKeyboardInsetController({
    native: true,
    keyboard: {
      addListener: async (event, handler) => {
        listeners.set(event, handler);
        return { remove: () => listeners.delete(event) };
      },
    },
    root: { style: { setProperty: (name, value) => writes.push([name, value]) } },
    getSurface: () => ({
      regionRef: { current: region },
      scrollerRef: { current: scroller },
      dockRef: { current: dock },
    }),
    readTransform: (element) => element.transform,
    readRect: (element) => ({ bottom: element.bottom }),
    readViewportHeight: () => viewportHeight,
    viewport,
  });
  return { controller, listeners, writes };
}

function travelKeyframes(element) {
  return element.animations.at(-1).keyframes;
}

test('the list and the composer travel together and the layout does not move until they land', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  // 展开期间布局一次都不动：动的只有合成层上的那一个位移。
  assert.deepEqual(writes, []);
  // 852 - 810 = 42 是输入框静息时离屏幕底的那段，336 - 42 = 294 才是这两块要走的路。
  const expected = [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, -294px, 0)' },
  ];
  assert.deepEqual(travelKeyframes(region), expected);
  assert.deepEqual(travelKeyframes(dock), expected);
  assert.equal(region.animations.at(-1).options.easing, KEYBOARD_MOTION_EASING);
  assert.equal(dock.animations.at(-1).options.duration, region.animations.at(-1).options.duration);
  // 层内部的定时渐变/阴影在这段里停一停。
  assert.equal(region.classes.has(KEYBOARD_MOTION_CLASS), true);

  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '294px']]);
  assert.equal(region.animations.at(-1).cancelled, true);
  assert.equal(dock.animations.at(-1).cancelled, true);
  assert.equal(region.classes.has(KEYBOARD_MOTION_CLASS), false);

  // 收起：位移反向，落地之后布局才回到 0。
  listeners.get('keyboardWillHide')();
  await null;
  assert.equal(travelKeyframes(region).at(-1).transform, 'translate3d(0, 294px, 0)');
  assert.equal(travelKeyframes(dock).at(-1).transform, 'translate3d(0, 294px, 0)');
  listeners.get('keyboardDidHide')();
  assert.deepEqual(writes.slice(-2), [[KEYBOARD_INSET_VAR, '0px'], [KEYBOARD_LIFT_VAR, '0px']]);
  controller.stop();
});

test('the landing writes the thread back to the bottom itself, without waiting for its ResizeObserver', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  // 落地后的消息列表只矮了「上移量」那一段：键盘拿走 336，输入框自己的静息空隙 42 同时收掉。
  scroller.clientHeight = 585 - 336 + 42;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.equal(scroller.scrollTop, 4000 - (585 - 336 + 42));
  controller.stop();
});

test('a reader who scrolled up is left exactly where they are when the layout lands', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3015 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  // 离底 400px：看的是历史，不是最新消息。键盘只盖住列表下缘，列表一点都不动（输入框照走）。
  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  assert.equal(region.animations.length, 0);
  assert.equal(region.classes.has(KEYBOARD_MOTION_CLASS), false);
  assert.equal(dock.animations.at(-1).keyframes.at(-1).transform, 'translate3d(0, -294px, 0)');

  scroller.clientHeight = 585 - 336;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.equal(scroller.scrollTop, 3015);
  // 列表没往上下多长一段，所以 --keyboard-lift 是 0：这一层没动，也就没有多出来的窗口去补。
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '0px']]);
  controller.stop();
});

test('a landing event without its show still raises the layout', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  // `keyboardWillShow` 丢过一次：落地事件自己带着高度，布局照旧抬起（这一步允许直接落地）。
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  await null;
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '294px']]);
  controller.stop();
});

test('a QuickType-bar report of 0 does not lower the layout while the keyboard is up', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '294px']]);

  // 只多了一条 QuickType 提示栏（插件把这种变动报成 0）：键盘还在，布局不动。
  listeners.get('keyboardWillShow')({ keyboardHeight: 0 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 0 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '294px']]);
  controller.stop();
});

test('a motion that gets interrupted picks up from the pixel it is on', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  // 展开还没走完就收起：两块都从各自当前的像素接着往下走，而不是从头再来。
  region.transform = 'matrix(1, 0, 0, 1, 0, -120)';
  dock.transform = 'matrix(1, 0, 0, 1, 0, -120)';
  listeners.get('keyboardWillHide')();
  await null;
  assert.deepEqual(travelKeyframes(region), [
    { transform: 'translate3d(0, -120px, 0)' },
    { transform: 'translate3d(0, 0px, 0)' },
  ]);
  assert.deepEqual(travelKeyframes(dock), [
    { transform: 'translate3d(0, -120px, 0)' },
    { transform: 'translate3d(0, 0px, 0)' },
  ]);
  controller.stop();
});

test('a field inside the thread is pulled back above the input bar once the keyboard has landed', async () => {
  const answer = { scrollIntoView: (options) => answer.calls.push(options), calls: [] };
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  scroller.ownerDocument = { activeElement: answer };
  scroller.contains = (node) => node === answer;
  const { controller, listeners } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(answer.calls, [{ block: 'nearest' }]);
  controller.stop();
});

test('a surface that is not there yet only gets the layout, never a stray animation', async () => {
  const writes = [];
  const listeners = new Map();
  const controller = createKeyboardInsetController({
    native: true,
    keyboard: {
      addListener: async (event, handler) => {
        listeners.set(event, handler);
        return { remove: () => listeners.delete(event) };
      },
    },
    root: { style: { setProperty: (name, value) => writes.push([name, value]) } },
    getSurface: () => null,
  });
  await controller.start();

  // 目录页（或者这一页还没有会话）里没有能跟键盘移动的列表：只写布局，上长量留在 0。
  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '0px']]);
  controller.stop();
});

test('a collapse that animates the thread lifts the layout in the same frame, so no black band can open above it', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3015 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  // 先在翻上去看历史时抬起键盘：列表不动，布局里也不抬（窗口就矮一段，读者位置不变）。
  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  scroller.clientHeight = 585 - 294;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '0px']]);

  // 读者滑回底部，再收键盘：这一次列表要跟着键盘落下。布局里那一段必须**在动画开始时**就抬着，
  // 否则窗口整块往下滑、页头下面露出一条键盘高、纯黑的缺口（1.36 的「短暂黑屏」）。
  scroller.scrollTop = 4000 - scroller.clientHeight;
  scroller.clientHeight = 585;
  listeners.get('keyboardWillHide')();
  await null;
  assert.deepEqual(writes.at(-1), [KEYBOARD_LIFT_VAR, '294px']);
  assert.deepEqual(travelKeyframes(region), [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, 294px, 0)' },
  ]);
  // 布局换手和滚动在同一个任务里：抬起来的那 294px 从滚动位置上扣掉，画面不动（扣完正好贴底）。
  assert.equal(scroller.scrollTop, 4000 - 585);

  // 落地：布局回到 0，滚动还是同一个落点。
  listeners.get('keyboardDidHide')();
  assert.deepEqual(writes.slice(-2), [[KEYBOARD_INSET_VAR, '0px'], [KEYBOARD_LIFT_VAR, '0px']]);
  assert.equal(scroller.scrollTop, 4000 - 585);
  controller.stop();
});

test('a collapse that leaves the thread alone still keeps the reader on the same pixel', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners } = controllerFor({ region, dock, scroller });
  await controller.start();

  // 贴着底开键盘：列表跟着抬起，布局里那一段也抬着（窗口高度不变，滚动位置不用动）。
  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.equal(scroller.scrollTop, 3415);

  // 读者翻上去看历史，再收键盘：这一次列表不跟着走（键盘只是盖住下缘），但布局里那一段要收回，
  // 窗口上沿回到页头；窗口里的内容相对位置靠滚动补回来，读者看到的那一屏不动。
  scroller.scrollTop = 2000;
  const animated = region.animations.length;
  listeners.get('keyboardWillHide')();
  await null;
  assert.equal(region.animations.length, animated);
  listeners.get('keyboardDidHide')();
  assert.equal(scroller.scrollTop, 2000 + 294);
  controller.stop();
});

test('a document the WebView pushed aside is put back when the keyboard lands', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const scrolled = [];
  const viewport = { scrollX: 0, scrollY: 0, scrollTo: (x, y) => scrolled.push([x, y]) };
  const { controller, listeners } = controllerFor({ region, dock, scroller, viewport });
  await controller.start();

  // 键盘弹出时 WKWebView 自己把文档顶上去了：插件只把 contentInset 清回 0，contentOffset 不管。
  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  viewport.scrollY = 308;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(scrolled, [[0, 0]]);

  // 文档没被顶走时不碰它：多推几次只会多几次没意义的滚动。
  viewport.scrollY = 0;
  listeners.get('keyboardWillHide')();
  await null;
  listeners.get('keyboardDidHide')();
  assert.deepEqual(scrolled, [[0, 0]]);
  controller.stop();
});

test('a keyboard that changes height while it is up moves the two blocks by the difference, not by the whole lift', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px'], [KEYBOARD_LIFT_VAR, '294px']]);

  // 换上一把更高的键盘（带工具栏的第三方输入法）：布局里已经抬着 336-42 = 294，这一次要走的只是
  // 431-336 = 95。再补一整段（-389）就是把输入框甩到键盘上方一百多点——用户报的「切换键盘，输入框又往上跑」。
  listeners.get('keyboardWillShow')({ keyboardHeight: 431 });
  await null;
  assert.deepEqual(travelKeyframes(region), [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, -95px, 0)' },
  ]);
  assert.deepEqual(travelKeyframes(dock), [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, -95px, 0)' },
  ]);

  // 落地时布局接到新高度上，滚动位置还是贴底。
  scroller.clientHeight = 585 - 431 + 42;
  listeners.get('keyboardDidShow')({ keyboardHeight: 431 });
  assert.deepEqual(writes.slice(-2), [[KEYBOARD_INSET_VAR, '431px'], [KEYBOARD_LIFT_VAR, '389px']]);
  assert.equal(scroller.scrollTop, 4000 - scroller.clientHeight);
  controller.stop();
});

test('a keyboard that comes back shorter lands on the new height, not on the taller one', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ region, dock, scroller });
  await controller.start();

  // 先起来一把高的（431），再换成 291 的系统键盘：这一趟往下走 431-291 = 140。
  listeners.get('keyboardWillShow')({ keyboardHeight: 431 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 431 });
  listeners.get('keyboardWillShow')({ keyboardHeight: 291 });
  await null;
  assert.deepEqual(travelKeyframes(region), [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, 140px, 0)' },
  ]);

  // 上移量也要跟着缩到 291-42 = 249：消息列表的窗口不能一直按高的那把算。
  scroller.clientHeight = 585 - 291 + 42;
  listeners.get('keyboardDidShow')({ keyboardHeight: 291 });
  assert.deepEqual(writes.slice(-2), [[KEYBOARD_INSET_VAR, '291px'], [KEYBOARD_LIFT_VAR, '249px']]);
  controller.stop();
});

test('the frame the app forwards is what tells the layout the keyboard changed', async () => {
  const region = fakeTraveler();
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const viewport = fakeViewport();
  const { controller, listeners } = controllerFor({ region, dock, scroller, viewport });
  await controller.start();
  assert.deepEqual(viewport.listening, [KEYBOARD_FRAME_EVENT]);

  // 换键盘时插件一声不响（iOS 只发了 UIKeyboardWillChangeFrameNotification）：AppDelegate 转发的
  // frame 自己把这一层带到新高度上——从静息位（离底 42）起走 431-42 = 389。
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { detail: { height: 431 } });
  assert.deepEqual(travelKeyframes(region), [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, -389px, 0)' },
  ]);
  listeners.get('keyboardDidShow')({ keyboardHeight: 431 });
  await null;

  // 键盘离开屏幕（收起时 iOS 把 frame 挪到屏幕外，报 0）：和 `keyboardWillHide` 是一回事，
  // 这一趟把已经写在布局里的 431 放回去。
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { detail: { height: 0 } });
  assert.deepEqual(travelKeyframes(dock).at(-1).transform, 'translate3d(0, 389px, 0)');
  listeners.get('keyboardDidHide')();

  // 会话关掉就把监听收回：回到目录页之后不再有人往这一层报键盘。
  controller.stop();
  assert.deepEqual(viewport.listening, []);
});

test('the browser leaves the keyboard to the browser', async () => {
  const calls = [];
  const stop = mountKeyboardInset({
    native: false,
    keyboard: { addListener: (event) => calls.push(event) },
    root: { style: { setProperty: () => calls.push('write') } },
  });
  assert.deepEqual(calls, []);
  stop();
});
