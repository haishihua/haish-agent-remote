import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the iOS root controller enables WebKit native back-forward gestures', async () => {
  const [controller, storyboard, project] = await Promise.all([
    read('../ios/App/App/HaishBridgeViewController.swift'),
    read('../ios/App/App/Base.lproj/Main.storyboard'),
    read('../ios/App/App.xcodeproj/project.pbxproj'),
  ]);

  assert.match(controller, /class HaishBridgeViewController: CAPBridgeViewController/);
  assert.match(controller, /override func capacitorDidLoad\(\)/);
  assert.match(controller, /allowsBackForwardNavigationGestures = true/);
  assert.match(storyboard, /customClass="HaishBridgeViewController"/);
  assert.match(storyboard, /customModule="App"/);
  assert.match(project, /HaishBridgeViewController\.swift in Sources/);
});

test('the native controller forwards keyboard frames directly to the WebView', async () => {
  const [controller, delegate] = await Promise.all([
    read('../ios/App/App/HaishBridgeViewController.swift'),
    read('../ios/App/App/AppDelegate.swift'),
  ]);

  assert.match(controller, /keyboardWillChangeFrameNotification/);
  assert.match(controller, /webView\.evaluateJavaScript\("window\.dispatchEvent\(new CustomEvent\('haishKeyboardFrame'/);
  assert.match(controller, /keyboardAnimationDurationUserInfoKey/);
  assert.doesNotMatch(delegate, /selector: #selector\(keyboardWillChangeFrame/);
  assert.doesNotMatch(delegate, /bridge\.eval\(js:/);
});

test('the retired JavaScript edge-pan recognizer is not wired into the app', async () => {
  const app = await read('../src/App.jsx');
  assert.doesNotMatch(app, /from ['"]\.\/swipe-back\.js['"]/);
  assert.doesNotMatch(app, /addEventListener\(['"]touchmove['"], handlers\.move/);
  assert.match(app, /addEventListener\(['"]popstate['"], handlePopState/);
});
