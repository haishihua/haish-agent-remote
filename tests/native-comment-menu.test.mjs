import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  NATIVE_ADD_COMMENT_EVENT,
  NATIVE_ANNOTATION_SELECTION_HANDLER,
  addNativeCommentListener,
  reportNativeAnnotationSelection,
} from '../src/native-comment-menu.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the native annotation bridge uses stable event and handler names', () => {
  assert.equal(NATIVE_ADD_COMMENT_EVENT, 'haishNativeAddComment');
  assert.equal(NATIVE_ANNOTATION_SELECTION_HANDLER, 'haishAnnotationSelection');
});

test('selection availability is reported as a boolean to WebKit', () => {
  const values = [];
  const bridge = { haishAnnotationSelection: { postMessage: (value) => values.push(value) } };
  reportNativeAnnotationSelection(1, bridge);
  reportNativeAnnotationSelection(0, bridge);
  assert.deepEqual(values, [true, false]);
});

test('the native Add Comment event listener cleans itself up', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
  };
  let calls = 0;
  const remove = addNativeCommentListener(() => { calls += 1; }, target);
  listeners.get(NATIVE_ADD_COMMENT_EVENT)();
  assert.equal(calls, 1);
  remove();
  assert.equal(listeners.has(NATIVE_ADD_COMMENT_EVENT), false);
});

test('iOS installs Add Comment into the native edit menu without private WKContentView access', async () => {
  const controller = await read('../ios/App/App/HaishBridgeViewController.swift');
  assert.match(controller, /class HaishWebView: WKWebView/);
  assert.match(controller, /UIAction\(title: "Add Comment"/);
  assert.match(controller, /builder\.insertSibling\(menu, afterMenu: \.standardEdit\)/);
  assert.match(controller, /UIMenuItem\(title: "Add Comment"/);
  assert.match(controller, /if #available\(iOS 16\.0, \*\)/);
  assert.match(controller, /#selector\(HaishWebView\.addComment\(_:\)\)/);
  assert.match(controller, /haishNativeAddComment/);
  assert.match(controller, /haishAnnotationSelection/);
  assert.match(controller, /override func canPerformAction/);
  assert.match(controller, /UIMenuSystem\.context\.setNeedsRebuild\(\)/);
  assert.doesNotMatch(controller, /WKContentView|value\(forKey:|NSClassFromString/);
});
