import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('typing keeps the draft in the textarea instead of React state', async () => {
  const app = await read('../src/App.jsx');

  assert.doesNotMatch(app, /const \[message, setMessage\] = useState/);
  assert.doesNotMatch(app, /const \[hasMessage, setHasMessage\] = useState/);
  assert.doesNotMatch(app, /setHasMessage\(/);
  assert.doesNotMatch(app, /value=\{message\}/);
  assert.match(app, /messageInputRef\.current\?\.value/);
  assert.match(app, /syncComposerMessageState\(event\.currentTarget/);
  assert.match(app, /markComposerInputActivity\(\)/);
  assert.match(app, /setComposerInputFocused\(true\)/);
  assert.match(app, /setComposerInputFocused\(false\)/);
  assert.match(app, /onCompositionStart=/);
  assert.match(app, /onCompositionEnd=/);
  assert.match(app, /event\.nativeEvent\.isComposing \|\| composerComposingRef\.current/);
});

test('typing and keyboard changes never measure textarea layout', async () => {
  const [app, css] = await Promise.all([read('../src/App.jsx'), read('../src/styles.css')]);

  assert.doesNotMatch(app, /createComposerTextareaFitScheduler/);
  assert.doesNotMatch(app, /createComposerViewportResizeHandler/);
  assert.doesNotMatch(app, /textareaFitSchedulerRef/);
  assert.doesNotMatch(app, /\.scrollHeight/);
  assert.match(css, /\.composer\.expanded textarea \{[^}]*height: 60px;[^}]*min-height: 60px;[^}]*max-height: 60px;[^}]*line-height: 22px;/);
});

test('the trusted composer tap focuses once and focus expands the isolated overlay', async () => {
  const app = await read('../src/App.jsx');

  assert.match(app, /function activateComposer\(event\)/);
  assert.doesNotMatch(app, /event\?\.type === 'pointerdown'.*event\.preventDefault\(\)/);
  assert.match(app, /event\.currentTarget\.form\?\.classList\.add\('expanded'\)/);
  assert.doesNotMatch(app, /\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(app, /onPointerDown=\{activateComposer\}/);
  assert.match(app, /rows=\{2\} disabled=\{busy\} onFocus=\{activateComposer\}/);
});

test('IME text toggles only composer DOM state and keeps both action buttons mounted', async () => {
  const [app, css] = await Promise.all([read('../src/App.jsx'), read('../src/styles.css')]);

  assert.match(app, /form\?\.classList\.toggle\('has-message', hasText\)/);
  assert.match(app, /form\?\.querySelector\?\.\('\.composer-send-button'\)/);
  assert.match(app, /composer-stop-button/);
  assert.match(app, /composer-send-button/);
  assert.match(css, /\.composer-stop-button \{ display: none; \}/);
  assert.match(css, /\.composer\.is-running:not\(\.has-message\):not\(\.has-image\) \.composer-stop-button/);
});

test('the photo button keeps the textarea focused until its click opens the picker', async () => {
  const app = await read('../src/App.jsx');

  assert.match(app, /function beginPhotoLongPress\(event\)/);
  assert.match(app, /beginPhotoLongPress\(event\)[\s\S]*?event\.preventDefault\(\)/);
  assert.match(app, /onPointerDown=\{beginPhotoLongPress\}/);
  assert.match(app, /function finishPhotoPress\(\)[\s\S]*?openPhotoPicker\(\)/);
  assert.match(app, /onPointerUp=\{finishPhotoPress\}/);
  assert.match(app, /onClick=\{\(\) => \{[\s\S]*?openPhotoPicker\(\)/);
});

test('keyboard motion isolates the composer from the long message tree', async () => {
  const [app, keyboard, css] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/ios-keyboard.js'),
    read('../src/styles.css'),
  ]);

  assert.match(app, /followingRef=\{keyboardFollowingRef\}/);
  assert.doesNotMatch(keyboard, /getComputedStyle\(|getBoundingClientRect\(|\.scrollHeight|\.clientHeight/);
  assert.doesNotMatch(keyboard, /paddingBottom|scrollTop/);
  assert.doesNotMatch(keyboard, /regionRef|message-region|\.region/);
  assert.match(css, /\.composer-dock \{ position: absolute;/);
  assert.match(css, /\.message-scroll \{[^}]*contain: layout paint style;/);
  assert.match(css, /\.chat-row \{ content-visibility: auto;/);
});

test('the expensive detail subtrees have memo boundaries and stable props', async () => {
  const [app, thread, approvals] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/chat-view.jsx'),
    read('../src/approval-slot.jsx'),
  ]);

  assert.match(thread, /export const ChatThread = React\.memo\(ChatThreadComponent\)/);
  assert.match(approvals, /export const ChatApprovalSlot = React\.memo\(ChatApprovalSlotComponent\)/);
  assert.match(app, /const previewThreadImage = useCallback/);
  assert.match(app, /onPreviewImage=\{previewThreadImage\}/);
  assert.doesNotMatch(app, /onPreviewImage=\{\(image\) =>/);
});
