#!/usr/bin/env node
// 构建后核一遍样式包：桌面 markdown 组件（Streamdown 的表格 / 代码块 / 行内代码 / 列表）
// 要用的那批 Tailwind 工具类必须在场。
//
// 为什么非得在**构建产物**上核：这批类是从桌面 markdown.css 的 `@source` 扫出来的，而本地
// 永远扫得到（本地的桌面仓库装着依赖），CI 里扫不到（桌面只 checkout 源码）。第 51 次构建
// 发出去的包就是这么坏的——手机上表格列错位、代码块没底色，而两个仓库的单测、本地 build
// 全绿。这是「产物 vs 环境」的差别，只能在产物上验，见 scripts/gen-desktop-markdown-css.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
// 默认核本仓刚构建的产物；也可以传一个目录（比如解包出来的 IPA 里的 assets），
// 用来核「发出去的那个包」到底有没有这批类。
const assetsDir = path.resolve(process.argv[2] || path.join(projectRoot, 'dist', 'assets'));

/** 类名 → 用在哪（缺了就是哪块坏掉）。 */
const REQUIRED_CLASSES = [
  ['bg-muted', '表格表头 / 代码块表头的底色'],
  ['rounded-md', '表格 / 代码块的圆角'],
  ['divide-y', '表格行之间的分隔线'],
  ['max-w-full', '表格 / 代码块不撑破气泡'],
  ['overflow-x-auto', '宽表格 / 长代码的横向滚动'],
  ['text-muted-foreground', '代码块标题这类次要文字'],
];

/** 桌面 markdown.css 的结构性规则（不是工具类，但同桌坏掉：少了说明那份样式没进包）。
 *  注意压缩后属性选择器的引号会被去掉（`[data-streamdown="table-wrapper"]` →
 *  `[data-streamdown=table-wrapper]`），所以比对前先把引号抹掉。 */
const REQUIRED_SELECTORS = ['[data-streamdown=table-wrapper]', '.haish-markdown'];

/** 手机态覆盖（`src/styles.css` 压在桌面同名类上的那几条）。这些是“手机上故意跟桌面不一样”
 *  的地方，也是靠构建产物才能确认的东西：样式表被谁后加载、那条规则有没有真的落在后面的那份
 *  CSS 里，只有产物上能看。比对前先把空白抹掉（压缩后是 `.a{display:none}`）。 */
const REQUIRED_OVERRIDES = [
  ['.chat-trace-pending{display:none}', '不画桌面那句「Steps load when you scroll up.」'],
  ['.haish-annotation-drafts>.haish-quote-block{width:100%;max-width:100%;margin:0}', '引用批注的草稿在手机上占满一行（桌面是最宽 480px 的并排块）'],
  ['html.native-app.haish-annotation-floating{position:absolute!important', 'iOS 评论编辑器固定在 composer dock 上方，随键盘一起移动'],
  ['.chat-message-row.user.haish-sent-annotations.haish-quote-text{-webkit-line-clamp:3', '已发送的长引用在用户气泡里截为三行'],
  ['.chat-message-row.message-shell~.chat-message-actions{opacity:1;pointer-events:auto}', '消息行的时间与复制按钮常显（桌面是悬停那一行才亮）'],
  ['.aui-tool-detail.haish-tool-elements[data-slot=code-diff]{width:100%;max-width:100%;overflow:hidden', '移动端 CodeDiff 有完整面板而不是只有逐行底色'],
];

if (!fs.existsSync(assetsDir)) {
  console.error(`verify-bundled-styles: 没有 ${path.relative(projectRoot, assetsDir)}，先跑 npm run build。`);
  process.exit(1);
}

const cssFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.css'));
if (!cssFiles.length) {
  console.error('verify-bundled-styles: dist/assets 下没有 CSS，构建没跑完？');
  process.exit(1);
}
const bundle = cssFiles
  .map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8'))
  .join('\n')
  .replace(/"/g, '');

const missing = [];
for (const [name, where] of REQUIRED_CLASSES) {
  if (!new RegExp(`\\.${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`).test(bundle)) {
    missing.push(`.${name}（${where}）`);
  }
}
const compact = bundle.replace(/\s+/g, '');
const missingOverrides = [];
for (const [rule, where] of REQUIRED_OVERRIDES) {
  if (!compact.includes(rule)) missingOverrides.push(`${rule}（${where}）`);
}

for (const selector of REQUIRED_SELECTORS) {
  if (!bundle.includes(selector)) missing.push(`${selector}（桌面 markdown 的结构规则）`);
}
if (missingOverrides.length) {
  console.error('verify-bundled-styles: 构建产物里少了手机压桌面的那几条覆盖（看 src/styles.css）：');
  for (const item of missingOverrides) console.error(`  ${item}`);
  process.exit(1);
}
if (missing.length) {
  console.error('verify-bundled-styles: 构建产物里少了桌面 markdown 要用的样式：');
  for (const item of missing) console.error(`  ${item}`);
  console.error('多半是桌面 markdown.css 的 @source 又扫不到包了——看 scripts/gen-desktop-markdown-css.mjs');
  console.error('（它把 @source 改指到手机自己的 node_modules）与 vite.config.js 里的 desktopMarkdownSeam 插件。');
  process.exit(1);
}

console.log(`verify-bundled-styles: ${cssFiles.length} 份 CSS 里都在（${REQUIRED_CLASSES.length} 个类 + ${REQUIRED_SELECTORS.length} 条结构规则 + ${REQUIRED_OVERRIDES.length} 条手机覆盖）`);
