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
  const activate = app.slice(app.indexOf('function activateComposer(event)'), app.indexOf('function collapseComposer'));

  assert.match(app, /function activateComposer\(event\)/);
  assert.doesNotMatch(app, /event\?\.type === 'pointerdown'.*event\.preventDefault\(\)/);
  assert.match(app, /event\.currentTarget\.form\?\.classList\.add\('expanded'\)/);
  // 展开只靠这一层类切换：被信任的点按自己建立第一响应者，这条路径绝不代劳 focus()。
  // （系统面板回来时那份恢复会 focus()，那是另一条路，见下面那条用例。）
  assert.doesNotMatch(activate, /\.focus\(/);
  assert.doesNotMatch(app, /onPointerDown=\{activateComposer\}/);
  assert.match(app, /rows=\{2\} disabled=\{busy \|\| composerPending\} onFocus=\{activateComposer\}/);
});

test('a dismissed photo sheet restores the composer it was opened from', async () => {
  const app = await read('../src/App.jsx');

  // 图片按钮只在展开态出现，而系统面板会先把键盘收掉：不恢复就是用户看到的「取消上传图片
  // 之后图标不见了，得关掉输入框再点一次」。
  assert.match(app, /function rememberComposerSheet\(\)/);
  assert.match(app, /rememberComposerSheet\(\)[\s\S]*?photoInputRef\.current\?\.click\(\)/);
  assert.match(app, /async function openPhotoPicker\(\)[\s\S]*?rememberComposerSheet\(\)/);
  assert.match(app, /pickImagesFromLibrary\([\s\S]*?\} finally \{\s*composerSheetRestore\(\);/);
  // 原生相册那条等 promise；`<input type="file">`（长按的相机/文件）没有 promise，
  // 等 Web 视图重新拿到焦点。
  assert.match(app, /window\.addEventListener\('focus', composerSheetRestore\)/);
  assert.match(app, /function composerSheetRestore\(\)[\s\S]*?classList\.add\('expanded'\)/);
});

test('the keyboard return key inserts a newline instead of sending', async () => {
  const app = await read('../src/App.jsx');

  // Return 不再提交：表单里唯一的发送入口是那颗发送按钮（submit 默认型），键盘只管换行。
  assert.doesNotMatch(app, /event\.key !== 'Enter'/);
  assert.doesNotMatch(app, /requestSubmit\(\)/);
  assert.match(app, /className="send-button composer-send-button"/);
});

test('a conversation renders its thread before the composer takes input', async () => {
  const [app, css] = await Promise.all([read('../src/App.jsx'), read('../src/styles.css')]);

  // 进会话先落 loading：整条线程（Markdown / 工具卡 / 时间线）渲染完之前，输入框只是占位。
  assert.match(app, /const \[threadReady, setThreadReady\] = useState\(false\)/);
  assert.match(app, /if \(!conversationHydrated\) return undefined;/);
  assert.match(app, /requestIdleCallback\(reveal, \{ timeout: THREAD_READY_IDLE_MS \}\)/);
  assert.match(app, /setTimeout\(\(\) => setThreadReady\(true\), THREAD_READY_MAX_MS\)/);
  // 加载期间的输入框：占位文案 + 不接手势。
  assert.match(app, /const composerPending = !threadReady;/);
  assert.match(app, /placeholder=\{composerPending \? 'Loading conversation…'/);
  assert.match(app, /data-blocked=\{busy \|\| composerPending/);
  assert.match(css, /\.composer\.is-loading \{ pointer-events: none; \}/);
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
