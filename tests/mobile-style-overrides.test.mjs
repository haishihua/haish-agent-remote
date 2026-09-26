// 手机上「故意画得跟桌面不一样」的覆盖写在 `src/styles.css`（它最后加载，压同名类名）。
// 这里钉住其中一条：桌面 `ChatMessageRow.jsx` 在执行记录还没拉到时会在正文上方写一句
// 「Steps load when you scroll up.」（`.chat-trace-pending`），手机上不画——执行记录是滚到
// 眼前自动拉的，一句没有容器的英文浮在正文上方就是一条没头没尾的字（用户：「怎么还有这个啊，
// 给我去掉」）。行本身不动：`traceHydrated` / `data-trace-pending` 都还在。
//
// 为什么连 `scripts/verify-bundled-styles.mjs` 一起钉：这条覆盖是**产物**上的事——桌面那份
// 样式与手机这份是两份表、两处加载，最后那一条有没有真的落到后面的 CSS 里，只有构建产物能看
// （同 `tests/desktop-markdown-css.test.mjs` 记的那次教训）。两处要一起改，所以一起钉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const RULE = '.chat-trace-pending { display: none; }';

test('手机样式表不画桌面的「Steps load when you scroll up.」', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(RULE), `src/styles.css 里应当有 \`${RULE}\``);
  // 这条覆盖是不是压在桌面那份之后由构建顺序决定（两份表里的属性不同，互不打架）；
  // 但只要没把它删掉就够了，所以只钉存在性。
});

test('check:styles 会核这条覆盖有没有落进构建产物', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.match(script, /REQUIRED_OVERRIDES/, '产物校验里要有一份手机态覆盖的清单');
  assert.ok(
    script.includes('.chat-trace-pending{display:none}'),
    '清单里要比对压缩后的 `.chat-trace-pending{display:none}`（属性选择器比对前先抹空白）',
  );
});

// 引用批注在手机上要压三层：输入区草稿占满一行但不能无限增高；原生编辑器固定在 dock
// 上方；发出去后的引用在用户气泡里保持紧凑。桌面样式与手机覆盖是两张表，所以这里钉最终覆盖。
const ANNOTATION_DRAFT_RULE = '.haish-annotation-drafts > .haish-quote-block { width: 100%; max-width: 100%; margin: 0; }';

test('手机样式表约束批注草稿、编辑器和已发送引用', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(ANNOTATION_DRAFT_RULE), `src/styles.css 里应当有 \`${ANNOTATION_DRAFT_RULE}\``);
  assert.ok(css.includes('.composer-dock { position: absolute;'), 'composer dock 应为原生评论编辑器提供独立覆盖层定位容器');
  assert.ok(css.includes('html.native-app .haish-annotation-floating { position: absolute !important;'), '原生评论编辑器应固定在 composer dock 上方');
  assert.ok(css.includes('.chat-message-row.user .haish-sent-annotations .haish-quote-text { -webkit-line-clamp: 3;'), '已发送长引用应在 iPhone 上截行');
  // 浏览器/PWA 没有 UIKit 菜单，后备入口直接复用桌面的 SelectionToolbar，只做尺寸适配。
  assert.ok(css.includes('.annotation-menu .haish-selection-toolbar button {'), '浏览器后备入口应适配桌面的 SelectionToolbar');
  assert.ok(!css.includes('.annotation-menu-item {'), '不应再维护一套手机专用批注按钮');
  assert.ok(css.includes('.composer.expanded > .haish-annotation-drafts,'), '展开输入框时引用标签仍应占满整行');
  assert.ok(css.includes('.composer.expanded textarea { min-width: 0; grid-column: 1 / -1;'), 'Continue this task 输入区应在引用标签下方另起整行');
  assert.ok(css.includes('.haish-annotation-editor textarea:focus-visible { outline: 0; box-shadow: none; }'), 'Add comment 输入框聚焦后不应出现高亮描边');
});

test('check:styles 的清单里也有这一条', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(
    script.includes('.haish-annotation-drafts>.haish-quote-block{width:100%;max-width:100%;margin:0}'),
    '清单里要比对压缩后的引用草稿覆盖',
  );
  assert.ok(script.includes('html.native-app.haish-annotation-floating{position:absolute!important'), '清单里要核原生编辑器定位');
  assert.ok(script.includes('.chat-message-row.user.haish-sent-annotations.haish-quote-text{-webkit-line-clamp:3'), '清单里要核已发送引用的截行');
  assert.ok(script.includes('.composer.expanded>.haish-annotation-drafts'), '清单里要核展开后的引用标签仍占满整行');
  assert.ok(script.includes('.composer.expandedtextarea{min-width:0;grid-column:1/-1'), '清单里要核展开后的正文输入区另起整行');
  assert.ok(script.includes('.annotation-menu.haish-selection-toolbarbutton{min-height:34px'), '清单里要核桌面 SelectionToolbar 的手机尺寸适配');
  assert.ok(script.includes('.haish-annotation-editortextarea:focus-visible{outline:0;box-shadow:none}'), '清单里要核 Add comment 输入框没有聚焦高亮');
});

// 消息行的时间（与它同排的复制按钮）在手机上常显：桌面那份是「悬停那一行才亮」，触摸设备靠
// `@media (hover: none)` 兜底——而手机上那条兜底不一定吃到，点过的行会留下 sticky hover，
// 于是只有「最新那条」有时间，历史消息与正在跑的那一轮都没有（用户原话：「最新完成的任务有，
// 历史任务没有」「正在跑的那一轮要显示开始时间 / 已用时」）。行本身的 `createdAt` 本来就在，
// 这一条只管可见性，所以选择器比桌面多一层 `.chat-message-row`：不管两份样式表的先后都说了算。
const ROW_ACTIONS_RULE = '.chat-message-row .message-shell ~ .chat-message-actions { opacity: 1; pointer-events: auto; }';

test('手机样式表把消息行的时间与复制按钮钉成常显', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(ROW_ACTIONS_RULE), `src/styles.css 里应当有 \`${ROW_ACTIONS_RULE}\``);
  // 桌面那份的 `@media (hover: none)` 兜底不能当唯一指望：它在行上只写 `.message-shell ~ …`，
  // 手机这条多一层类名，spec 上一定压得住（顺序变了也不怕）。
  assert.ok(!ROW_ACTIONS_RULE.includes('@media'), '常显这条不能塞进媒体查询里');
});

test('check:styles 的清单里也有常显这一条', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(
    script.includes('.chat-message-row.message-shell~.chat-message-actions{opacity:1;pointer-events:auto}'),
    '清单里要比对压缩后的「时间/复制按钮常显」覆盖',
  );
});

// 发送/停止键不吃那圈环。桌面的彩色环是 metal-fx 的 WebGL 装饰层，只在 running / 有文字 / 有图
// 时亮；手机上先前拿一层静态 conic-gradient 去顶替它，那圈浅色渐变贴在深色背景上就是一道发白的
// 框（用户：「这个发送和取消按钮也不需要这个白色框框，就静态样式跟客户端保持一致即可」）。
// 现在四种状态都落回桌面静止的那颗圆盘：send 用 .chat-send 那条（手机 40px→48px），stop 用桌面
// .chat-send.stop 那套略亮的描边与底色，只有图标（箭头 / 方块）在变。
test('手机样式表把发送/停止键钉成桌面的静态圆盘（不再挂彩环）', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(
    css.includes('.send-button.stop { color: #ffffff; border-color: rgba(102, 119, 154, 0.82); background: linear-gradient(180deg, #20293a, #151b27); }'),
    '停止键应落到桌面 .chat-send.stop 的静态描边与底色',
  );
  assert.ok(!/\.send-button[^{}]*\{[^}]*conic-gradient/.test(css), '发送/停止键不应再挂 conic-gradient 彩环');
});

// 「回到最新」在桌面上按在消息区底边上——也就是输入框正上方；手机这边输入框是覆盖层，按钮留在
// 消息区里会被压住、只从底下露出一截（用户：「图一中快速拉到最底的 icon 应该放在输入框上面，而不是
// 藏在输入框下面」）。所以它挂进 composer dock、用 bottom: calc(100% + 10px) 顶着 dock 的上边缘
// （dock 随键盘与草稿高度一起走）。位置这件事一半在 CSS、一半在 JSX 的挂载点，两处一起钉。
test('「回到最新」挂在 composer dock 上边缘（输入框上面）', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(
    css.includes('.composer-dock .scroll-to-bottom-button { position: absolute; z-index: 20; bottom: calc(100% + 10px);'),
    '「回到最新」应相对 composer dock 定位到它的上边缘（选择器多一层 .composer-dock，避让桌面同名类）',
  );
  const app = await readFile(path.join(repoRoot, 'src', 'App.jsx'), 'utf8');
  assert.equal((app.match(/<ScrollToBottomButton/g) || []).length, 1, '「回到最新」只应挂一处');
  assert.ok(
    app.indexOf('className="composer-dock"') < app.indexOf('<ScrollToBottomButton'),
    '「回到最新」要画在 composer dock 里（留在消息区会被输入框覆盖层压住）',
  );
});

test('check:styles 的清单里也有「回到最新」这条', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(
    script.includes('.composer-dock .scroll-to-bottom-button{position:absolute;z-index:20;bottom:calc(100% + 10px)'),
    '清单里要比对「回到最新」挂在 dock 上边缘这条覆盖',
  );
});
