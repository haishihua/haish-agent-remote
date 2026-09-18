// 桌面 `app-web/styles/markdown.css` 里的四条 `@source "../../node_modules/<包>/dist/..."`
// 指的是**桌面仓库**的 node_modules（Streamdown 的四份包）。CI 里桌面只 checkout 源码、
// 不装依赖：Tailwind 一条也扫不到，于是表格 / 代码块要用的那批工具类
// （bg-muted / divide-y / overflow-x-auto / rounded-md / text-muted-foreground …）在包里
// 根本不存在——而本地一路全绿（本地桌面仓库装着依赖，扫得到）。第 51 次构建发出去的包
// 就是这么坏的：手机上表格列错位、代码块没有底色。
//
// 接缝两半，两边都在这里钉住：
//   1) `scripts/gen-desktop-markdown-css.mjs` 把桌面那份原样复制一份，只改 @source 的起点
//      （改成手机自己的 node_modules；版本与桌面 pin 同批，见 vite.config.js 的 desktopPackages）；
//   2) `vite.config.js` 的 alias 把桌面的 `styles/markdown.css` 指到那份副本——全树只编译
//      一份，两份的话 theme / preflight / .haish-markdown 规则会各来一遍。
// 构建产物那一头由 `npm run check:styles`（scripts/verify-bundled-styles.mjs）在 CI 上兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteDesktopMarkdown } from '../scripts/gen-desktop-markdown-css.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const desktopMarkdown = path.resolve(repoRoot, '..', 'haish-agent', 'app-web', 'styles', 'markdown.css');
const generated = path.join(repoRoot, 'src', 'desktop-markdown.generated.css');
const DESKTOP_PREFIX = '@source "../../node_modules/';
const MOBILE_PREFIX = '@source "../node_modules/';

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('the desktop markdown stylesheet still carries the four node_modules @source globs', async () => {
  assert.ok(
    existsSync(desktopMarkdown),
    `${desktopMarkdown} 不在——跑单测要有 ../haish-agent 检出（CI 里由 workflow 检出 pin 的 ref）。`,
  );
  const source = await readFile(desktopMarkdown, 'utf8');
  assert.equal(count(source, DESKTOP_PREFIX), 4, '四条 @source（streamdown / @streamdown/code / mermaid / cjk）应当还在');
  for (const name of ['streamdown/dist', '@streamdown/code/dist', '@streamdown/mermaid/dist', '@streamdown/cjk/dist']) {
    assert.ok(source.includes(DESKTOP_PREFIX + name), `桌面 markdown.css 里少了 ${name} 那条 @source`);
  }
});

test('the copy points the globs at this repo and keeps everything else byte for byte', async () => {
  const source = await readFile(desktopMarkdown, 'utf8');
  const rewritten = rewriteDesktopMarkdown(source);
  const globs = count(source, DESKTOP_PREFIX);
  assert.equal(count(rewritten, DESKTOP_PREFIX), 0, '副本里不能再有指向桌面 node_modules 的 @source');
  assert.equal(count(rewritten, MOBILE_PREFIX), globs, '每一条都要改指到本仓的 node_modules');
  // 除了这四处起点，一个字都不动（桌面改了别的地方，这里要跟着变而不是被吞掉）。
  assert.equal(rewritten.split(MOBILE_PREFIX).join(DESKTOP_PREFIX), source);
});

test('the rewrite refuses to run when the desktop stylesheet loses its globs', () => {
  assert.throws(() => rewriteDesktopMarkdown('/* 桌面把 @source 搬走了 */'), /@source/);
});

test('vite resolves the desktop markdown stylesheet to the generated copy', async () => {
  const config = (await import('../vite.config.js')).default;
  const seam = (config.plugins || []).find((plugin) => plugin.name === 'haish:desktop-markdown-seam');
  assert.ok(seam, 'vite.config.js 里没有那条接缝');
  const generatedPath = path.join(repoRoot, 'src', 'desktop-markdown.generated.css');
  const desktopImporter = path.resolve(repoRoot, '..', 'haish-agent', 'app-web', 'src', 'shared', 'ui', 'Markdown.jsx');
  assert.equal(
    await seam.resolveId('../../../styles/markdown.css', desktopImporter),
    generatedPath,
    '桌面 Markdown.jsx 里那句相对 import 要落到副本上（resolve.alias 拦不住它）',
  );
  assert.equal(seam.resolveId('../../../styles/chat.css', desktopImporter), null, '别的桌面样式不动');
  assert.equal(seam.resolveId('./desktop-theme.css', path.join(repoRoot, 'src', 'chat-view.jsx')), null, '本仓的样式不动');
});

test('prebuild / predev regenerate the copy and the built bundle is checked', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const hook of ['prebuild', 'predev']) {
    assert.match(pkg.scripts[hook] || '', /gen-desktop-markdown-css\.mjs/, `${hook} 要重新生成副本（不然本地跑的是旧的一份）`);
  }
  assert.match(pkg.scripts['check:styles'] || '', /verify-bundled-styles\.mjs/, 'CI 上要核构建产物里的那批类');
  const ignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('src/desktop-markdown.generated.css'), '生成物不入库');
  assert.ok(existsSync(generated), '副本还没生成过——跑一次 npm run build 或 node scripts/gen-desktop-markdown-css.mjs');
});
