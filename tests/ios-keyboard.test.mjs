import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKeyboardInsetController,
  hideKeyboardAccessoryBar,
  isKeyboardMoving,
  KEYBOARD_FRAME_EVENT,
  KEYBOARD_MOTION_EASING,
  KEYBOARD_MOTION_MS,
  keyboardInset,
  keyboardLift,
  keyboardMotionMs,
  keyboardRemainingMs,
  mountKeyboardInset,
  registerKeyboardSurface,
} from '../src/ios-keyboard.js';

test('the accessory bar is hidden through the native plugin only', async () => {
  const calls = [];
  assert.equal(await hideKeyboardAccessoryBar({
    native: true,
    keyboard: { setAccessoryBarVisible: async (options) => calls.push(options) },
  }), true);
  assert.deepEqual(calls, [{ isVisible: false }]);
  calls.length = 0;
  assert.equal(await hideKeyboardAccessoryBar({
    native: false,
    keyboard: { setAccessoryBarVisible: async (options) => calls.push(options) },
  }), false);
  assert.deepEqual(calls, []);
});

test('keyboard frame numbers are clamped and native lift wins', () => {
  assert.equal(keyboardInset(336.4), 336);
  assert.equal(keyboardInset(-12), 0);
  assert.equal(keyboardInset(undefined), 0);
  assert.equal(keyboardLift({ keyboardHeight: 336, lift: 306 }), 306);
  assert.equal(keyboardLift({ keyboardHeight: 336 }), 336);
  assert.equal(keyboardLift({ keyboardHeight: 0, lift: -1 }), 0);
});

test('duration and remaining time stay on the UIKit timeline', () => {
  assert.equal(keyboardMotionMs(0.25), 250);
  assert.equal(keyboardMotionMs(0.35), 350);
  assert.equal(keyboardMotionMs(undefined), KEYBOARD_MOTION_MS);
  assert.equal(keyboardMotionMs(9), 600);
  assert.equal(keyboardRemainingMs({ at: 1000, now: 1120, duration: 250 }), 130);
  assert.equal(keyboardRemainingMs({ at: 1000, now: 1400, duration: 250 }), 0);
  assert.equal(keyboardRemainingMs({ at: null, now: 1000, duration: 250 }), 250);
});

function fakeViewport() {
  const handlers = new Map();
  return {
    scrollCalls: [],
    addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name) { handlers.delete(name); },
    dispatch(name, detail) { handlers.get(name)?.({ detail }); },
    scrollTo(x, y) { this.scrollCalls.push([x, y]); },
  };
}

function fakeDock() {
  const animations = [];
  const classes = new Set(['composer', 'expanded']);
  return {
    animations,
    style: {},
    classes,
    animate(keyframes, options) {
      const animation = {
        keyframes,
        options,
        cancelled: false,
        cancel() { animation.cancelled = true; },
      };
      animations.push(animation);
      return animation;
    },
    querySelector(selector) {
      if (selector !== '.composer') return null;
      return { classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } } };
    },
  };
}

function controllerFor({ following = true, clock = 10_000 } = {}) {
  const viewport = fakeViewport();
  const dock = fakeDock();
  const scroller = { style: {}, scrollTop: 0 };
  const timers = [];
  const followingRef = { current: following };
  const controller = createKeyboardInsetController({
    native: true,
    viewport,
    getSurface: () => ({
      dockRef: { current: dock },
      scrollerRef: { current: scroller },
      followingRef,
    }),
    readClock: () => clock,
    scheduleTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    unscheduleTimer: () => {},
  });
  controller.start();
  return { controller, viewport, dock, scroller, timers, followingRef };
}

test('show animates only the composer and does not read message geometry', () => {
  const { controller, viewport, dock, scroller, timers } = controllerFor();
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 336, lift: 306, duration: 0.25, at: 9_900 });

  assert.deepEqual(dock.animations.at(-1).keyframes, [
    { transform: 'translate3d(0, 0px, 0)' },
    { transform: 'translate3d(0, -306px, 0)' },
  ]);
  assert.deepEqual(dock.animations.at(-1).options, {
    duration: 250,
    delay: -100,
    easing: KEYBOARD_MOTION_EASING,
    fill: 'both',
  });
  assert.equal(scroller.style.paddingBottom, undefined, 'keyboard path never invalidates the long thread');
  assert.equal(scroller.scrollTop, 0);
  assert.equal(isKeyboardMoving(), true);
  assert.equal(timers.at(-1).ms, 150);

  assert.deepEqual(viewport.scrollCalls, []);
  timers.at(-1).callback();
  assert.equal(isKeyboardMoving(), false);
  controller.stop();
});

test('dismiss compacts immediately and reverses the small-layer animation', () => {
  const { controller, viewport, dock, scroller } = controllerFor();
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 336, lift: 306, duration: 0.25, at: 10_000 });
  const first = dock.animations.at(-1);
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 0, lift: 0, duration: 0.25, dismissal: true, at: 10_000 });

  assert.equal(first.cancelled, true);
  assert.equal(dock.classes.has('expanded'), false);
  assert.deepEqual(dock.animations.at(-1).keyframes, [
    { transform: 'translate3d(0, -306px, 0)' },
    { transform: 'translate3d(0, 0px, 0)' },
  ]);
  assert.equal(scroller.style.paddingBottom, undefined, 'dismiss does not relayout the thread');
  controller.stop();
});

test('input-method height changes animate from the previous native lift', () => {
  const { controller, viewport, dock } = controllerFor();
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 336, lift: 306, duration: 0.25, at: 10_000 });
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 431, lift: 401, duration: 0.25, at: 10_000 });
  assert.deepEqual(dock.animations.at(-1).keyframes, [
    { transform: 'translate3d(0, -306px, 0)' },
    { transform: 'translate3d(0, -401px, 0)' },
  ]);
  controller.stop();
});

test('a transient zero frame is ignored unless UIKit marks dismissal', () => {
  const { controller, viewport, dock } = controllerFor();
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 336, lift: 306, duration: 0.25, at: 10_000 });
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 0, lift: 0, duration: 0.25, dismissal: false, at: 10_000 });
  assert.equal(dock.animations.length, 1);
  assert.equal(dock.classes.has('expanded'), true);
  controller.stop();
});

test('a reader viewing history is not pinned to the latest message', () => {
  const { controller, viewport, scroller } = controllerFor({ following: false });
  viewport.dispatch(KEYBOARD_FRAME_EVENT, { height: 336, lift: 306, duration: 0.25, at: 10_000 });
  assert.equal(scroller.scrollTop, 0);
  controller.stop();
});

test('surface registration, browser no-op, and mount cleanup remain supported', () => {
  const release = registerKeyboardSurface({ dockRef: { current: {} } });
  assert.equal(typeof release, 'function');
  release();

  const viewport = fakeViewport();
  const controller = createKeyboardInsetController({ native: false, viewport });
  assert.equal(typeof controller.start(), 'function');
  controller.stop();

  const cleanup = mountKeyboardInset({ native: false, viewport });
  assert.equal(typeof cleanup, 'function');
  cleanup();
});
