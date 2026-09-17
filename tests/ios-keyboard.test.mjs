import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYBOARD_FOLLOW_SLACK,
  KEYBOARD_INSET_VAR,
  createKeyboardInsetController,
  hideKeyboardAccessoryBar,
  keyboardFollowing,
  keyboardInset,
  keyboardLanding,
  keyboardTravel,
  mountKeyboardInset,
  translateYOf,
} from '../src/ios-keyboard.js';

test('the browser and the test runner leave the keyboard bar alone', async () => {
  const calls = [];
  const keyboard = { setAccessoryBarVisible: (options) => calls.push(options) };
  assert.equal(await hideKeyboardAccessoryBar({ keyboard, native: false }), false);
  assert.deepEqual(calls, []);
  // 默认参数走真实的 isNativeApp：Node 里同样是浏览器路径。
  assert.equal(await hideKeyboardAccessoryBar(), false);
});

test('the native app hands the accessory bar to the Keyboard plugin', async () => {
  const calls = [];
  const keyboard = { setAccessoryBarVisible: async (options) => calls.push(options) };
  assert.equal(await hideKeyboardAccessoryBar({ keyboard, native: true }), true);
  assert.deepEqual(calls, [{ isVisible: false }]);
});

test('a rejected plugin call is not swallowed', async () => {
  const keyboard = { setAccessoryBarVisible: async () => { throw new Error('UNIMPLEMENTED'); } };
  await assert.rejects(hideKeyboardAccessoryBar({ keyboard, native: true }), /UNIMPLEMENTED/);
});

test('the layout gives up the keyboard\'s own height, nothing else', () => {
  assert.equal(keyboardInset(336), 336);
  assert.equal(keyboardInset('336'), 336);
  assert.equal(keyboardInset(0), 0);
  assert.equal(keyboardInset(undefined), 0);
  assert.equal(keyboardInset(Number.NaN), 0);
});

test('the landing is where the thread\'s own re-pin will put the scroll', () => {
  assert.equal(keyboardLanding({ contentHeight: 4000, viewportHeight: 585, inset: 302 }), 3717);
  assert.equal(keyboardLanding({ contentHeight: 200, viewportHeight: 585, inset: 302 }), 0);
  assert.equal(keyboardLanding({ contentHeight: 4000, viewportHeight: 585, inset: 302, scrollTop: 3015, following: false }), 3015);
});

test('the follow slack decides whether the list follows, exactly as the re-pin does', () => {
  assert.equal(keyboardFollowing({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 }), true);
  assert.equal(keyboardFollowing({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 - KEYBOARD_FOLLOW_SLACK }), true);
  assert.equal(keyboardFollowing({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 - KEYBOARD_FOLLOW_SLACK - 1 }), false);
  // 本来就装得下：不滚也在底部。
  assert.equal(keyboardFollowing({ contentHeight: 200, viewportHeight: 585, scrollTop: 0 }), true);
});

// 模型来自 ScrollToBottomButton 自己：`scrollTop = scrollHeight`，再由浏览器夹回上限。
function repinned({ contentHeight, viewportHeight, inset }) {
  return Math.min(contentHeight, Math.max(0, contentHeight - (viewportHeight - inset)));
}

test('the travel is exactly the scroll delta the settled layout will produce', () => {
  const opening = [
    { case: 'pinned to the bottom', contentHeight: 4000, viewportHeight: 585, scrollTop: 3415, inset: 302 },
    { case: 'still within the follow slack', contentHeight: 4000, viewportHeight: 585, scrollTop: 3375, inset: 302 },
    { case: 'already scrolled up', contentHeight: 4000, viewportHeight: 585, scrollTop: 3015, inset: 302 },
    { case: 'shorter than the keyboard', contentHeight: 200, viewportHeight: 585, scrollTop: 0, inset: 302 },
    { case: 'overflowing only the smaller box', contentHeight: 400, viewportHeight: 585, scrollTop: 0, inset: 302 },
    { case: 'closing again', contentHeight: 4000, viewportHeight: 283, scrollTop: 3717, inset: -302 },
  ];
  for (const item of opening) {
    const following = keyboardFollowing(item);
    const travel = keyboardTravel(item);
    assert.equal(travel.composer, -item.inset, item.case);
    // 位移说的是「内容往哪走」：吸底把 scrollTop 推大，内容对应的就是同值的向上。
    // 读者已经翻上去看历史时列表不跟，而吸底本来也不会把他拽回底部。
    assert.equal(travel.thread, following ? item.scrollTop - repinned(item) : 0, item.case);
    if (!following) assert.equal(travel.thread, 0, item.case);
  }
});

test('a thread the reader scrolled away from stays where it is while the composer still travels', () => {
  const travel = keyboardTravel({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3015, inset: 302 });
  assert.deepEqual(travel, { composer: -302, thread: 0 });
  // 回来时同理：收起不把读历史的人拽回底部。
  assert.deepEqual(
    keyboardTravel({ contentHeight: 4000, viewportHeight: 283, scrollTop: 2600, inset: -302 }),
    { composer: 302, thread: 0 },
  );
});

test('a computed transform yields its Y offset, so an interrupted motion resumes in place', () => {
  assert.equal(translateYOf('none'), 0);
  assert.equal(translateYOf(''), 0);
  assert.equal(translateYOf(undefined), 0);
  assert.equal(translateYOf('matrix(1, 0, 0, 1, 0, -120)'), -120);
  assert.equal(translateYOf('matrix(1, 0, 0, 1, 12, 0)'), 0);
  assert.equal(translateYOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -12, 0, 1)'), -12);
});

function fakeDock() {
  const animations = [];
  return {
    animations,
    transform: 'none',
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

function fakeScroll({ contentHeight = 0, viewportHeight = 0, scrollTop = 0 } = {}) {
  const animations = [];
  return {
    scrollHeight: contentHeight,
    clientHeight: viewportHeight,
    scrollTop,
    transform: 'none',
    animations,
    ownerDocument: { activeElement: null },
    contains: () => false,
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

function controllerFor({ dock, scroller, listeners = new Map(), writes = [] }) {
  const controller = createKeyboardInsetController({
    native: true,
    keyboard: {
      addListener: async (event, handler) => {
        listeners.set(event, handler);
        return { remove: () => listeners.delete(event) };
      },
    },
    root: { style: { setProperty: (name, value) => writes.push([name, value]) } },
    getSurface: () => ({ scrollerRef: { current: scroller }, dockRef: { current: dock } }),
    readTransform: (element) => element.transform,
  });
  return { controller, listeners, writes };
}

test('the layout does not move while the keyboard is in the air, and the two pieces travel instead', async () => {
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  // 展开期间布局一次都不动：动的只有合成层上的这两个位移。
  assert.deepEqual(writes, []);
  assert.deepEqual(dock.animations.at(-1).keyframes, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-336px)' }]);
  assert.deepEqual(scroller.animations.at(-1).keyframes, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-336px)' }]);
  assert.equal(dock.animations.at(-1).options.easing, 'cubic-bezier(0.32, 0.72, 0, 1)');

  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px']]);
  assert.equal(dock.animations.at(-1).cancelled, true);
  assert.equal(scroller.animations.at(-1).cancelled, true);

  // 收起：位移反向，落地之后布局才回到 0。
  listeners.get('keyboardWillHide')();
  await null;
  assert.equal(dock.animations.at(-1).keyframes.at(-1).transform, 'translateY(336px)');
  listeners.get('keyboardDidHide')();
  assert.deepEqual(writes.at(-1), [KEYBOARD_INSET_VAR, '0px']);
  controller.stop();
});

test('the landing writes the thread back to the bottom itself, without waiting for its ResizeObserver', async () => {
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners } = controllerFor({ dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  // 布局跟着键盘换过去：视口矮了 336，内容没变。落地这一步自己写回底部，不等 RO 那一帧。
  scroller.clientHeight = 585 - 336;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  // 3415 + 336：与动画走的是同一个落点（见 travel 那个用例）。
  assert.equal(scroller.scrollTop, 3751);
  controller.stop();
});

test('a reader who scrolled up is left exactly where they are when the layout lands', async () => {
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3015 });
  const { controller, listeners } = controllerFor({ dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  scroller.clientHeight = 585 - 336;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.equal(scroller.scrollTop, 3015);
  controller.stop();
});

test('a landing event without its show still raises the layout', async () => {
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ dock, scroller });
  await controller.start();

  // `keyboardWillShow` 丢过一次：落地事件自己带着高度，布局照旧抬起（这一步允许直接落地）。
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  await null;
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px']]);
  controller.stop();
});

test('a QuickType-bar report of 0 does not lower the layout while the keyboard is up', async () => {
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  const { controller, listeners, writes } = controllerFor({ dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px']]);

  // 只多了一条 QuickType 提示栏（插件把这种变动报成 0）：键盘还在，布局不动。
  listeners.get('keyboardWillShow')({ keyboardHeight: 0 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 0 });
  assert.deepEqual(writes, [[KEYBOARD_INSET_VAR, '336px']]);
  controller.stop();
});

test('a field inside the thread is pulled back above the input bar once the keyboard has landed', async () => {
  const answer = { scrollIntoView: (options) => answer.calls.push(options), calls: [] };
  const dock = fakeDock();
  const scroller = fakeScroll({ contentHeight: 4000, viewportHeight: 585, scrollTop: 3415 });
  scroller.ownerDocument = { activeElement: answer };
  scroller.contains = (node) => node === answer;
  const { controller, listeners } = controllerFor({ dock, scroller });
  await controller.start();

  listeners.get('keyboardWillShow')({ keyboardHeight: 336 });
  await null;
  listeners.get('keyboardDidShow')({ keyboardHeight: 336 });
  assert.deepEqual(answer.calls, [{ block: 'nearest' }]);
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
