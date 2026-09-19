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
});

test('the first composer tap expands and focuses in the same trusted pointer event', async () => {
  const app = await read('../src/App.jsx');

  assert.match(app, /function activateComposer\(event\)/);
  assert.doesNotMatch(app, /event\?\.type === 'pointerdown'.*event\.preventDefault\(\)/);
  assert.match(app, /input\?\.form\?\.classList\.add\('expanded'\)/);
  assert.match(app, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /onPointerDown=\{activateComposer\} onFocus=\{activateComposer\}/);
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
