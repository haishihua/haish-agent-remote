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
