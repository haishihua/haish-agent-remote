import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('typing keeps the draft in the textarea instead of React state', async () => {
  const app = await read('../src/App.jsx');

  assert.doesNotMatch(app, /const \[message, setMessage\] = useState/);
  assert.doesNotMatch(app, /value=\{message\}/);
  assert.match(app, /messageInputRef\.current\?\.value/);
  assert.match(app, /markComposerInputActivity\(\)/);
  assert.match(app, /onCompositionStart=/);
  assert.match(app, /onCompositionEnd=/);
  assert.match(app, /event\.nativeEvent\.isComposing \|\| composerComposingRef\.current/);
});

test('keyboard height changes do not force textarea remeasurement', async () => {
  const app = await read('../src/App.jsx');

  assert.match(app, /createComposerViewportResizeHandler/);
  assert.match(app, /shouldSchedule: \(\) => !composerComposingRef\.current/);
  assert.doesNotMatch(app, /const fit = \(\) => textareaFitSchedulerRef\.current\.schedule\(messageInputRef\.current, \{ force: true \}\)/);
});

test('the first composer tap expands and focuses in the same trusted pointer event', async () => {
  const app = await read('../src/App.jsx');

  assert.match(app, /function activateComposer\(event\)/);
  assert.doesNotMatch(app, /event\?\.type === 'pointerdown'.*event\.preventDefault\(\)/);
  assert.match(app, /input\?\.form\?\.classList\.add\('expanded'\)/);
  assert.match(app, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /onPointerDown=\{activateComposer\} onFocus=\{activateComposer\}/);
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

test('a keyboard motion defers the textarea fit instead of stealing its frames', async () => {
  const app = await read('../src/App.jsx');

  // 键盘动画那几百毫秒里不量高：一次强制布局落在键盘事件到达的窗口里，输入框就晚一步才跟上。
  assert.match(app, /import \{[\s\S]*?isKeyboardMoving[\s\S]*?\} from '\.\/ios-keyboard\.js'/);
  assert.match(app, /createComposerTextareaFitScheduler\(\{ shouldDefer: isKeyboardMoving \}\)/);
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
