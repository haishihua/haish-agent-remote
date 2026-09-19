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

// 引用批注（桌面的「添加注释」）那几块在手机上要改的就一处：桌面的草稿行是一行里并排几块
// （每块最宽 480px），手机上就这么宽，得一块一行。桌面那份 `message-annotations.css` 与手机
// 这份是两张表（见 scripts/gen-desktop-base-css.mjs 那条注），所以这一条也是产物上的事。
const ANNOTATION_DRAFT_RULE = '.haish-annotation-drafts > .haish-quote-block { width: 100%; max-width: 100%; margin: 0; }';

test('手机样式表把引用草稿改成一块一行', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(ANNOTATION_DRAFT_RULE), `src/styles.css 里应当有 \`${ANNOTATION_DRAFT_RULE}\``);
  // 选区菜单是 App 自绘的那一块（深色浮层），跟草稿行一起钉住：菜单的浮层是手机自己画的，
  // 这条没了就是「选中文字后什么都没出现」。
  assert.ok(css.includes('.annotation-menu-item {'), 'src/styles.css 里应当有自绘选区菜单的样式');
});

test('check:styles 的清单里也有这一条', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(
    script.includes('.haish-annotation-drafts>.haish-quote-block{width:100%;max-width:100%;margin:0}'),
    '清单里要比对压缩后的引用草稿覆盖',
  );
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
