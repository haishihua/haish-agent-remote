import test from 'node:test';
import assert from 'node:assert/strict';

import { hideKeyboardAccessoryBar } from '../src/ios-keyboard.js';

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
