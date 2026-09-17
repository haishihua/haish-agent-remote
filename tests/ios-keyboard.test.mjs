import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKeyboardInsetController,
  hideKeyboardAccessoryBar,
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

function controllerFor({ region, dock, scroller, viewportHeight = 852, listeners = new Map(), writes = [] }) {
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
