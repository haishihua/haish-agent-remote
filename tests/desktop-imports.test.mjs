// 手机端把桌面的 chat 执行 UI 从 `../haish-agent` 检出里 import（见 vite.config.js）。
// 这条路径是硬的：CI 里两个仓库是并排 checkout 的（`.github/workflows/build-ios-unsigned.yml`：
// 手机 → `haish-agent-remote/`，桌面 → `haish-agent/`），所以从 `src/` 出发正好是
// `../../haish-agent/...`。
//
// 少一级（`../haish-agent/...`）时 vite **本地也解析不了**，但只有 `npm run build` 会
// 报，`node --test` 一路绿——第 48 次构建就是这么挂在 CI 上的。这个用例把这类错误拉回
// 到单测里：凡是往 `src/` 外伸手的 import，路径必须真的落在检出里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcRoot = path.join(repoRoot, 'src');

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.(js|jsx|mjs|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// import './x.css' / import x from '../../haish-agent/y.jsx' / @import '...' 都收进来。
function specifiers(source) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"\n]*from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/g,
    /from\s+['"]((?:\.\.\/)+haish-agent\/[^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

test('every path that reaches out of src/ into the desktop checkout resolves', async () => {
  const files = await sourceFiles(srcRoot);
  assert.ok(files.length > 10, 'src/ 里找不到源文件，路径算错了');

  const outsideSrc = [];
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const specifier of specifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved.startsWith(srcRoot + path.sep)) continue;
      outsideSrc.push([file, specifier]);
      if (!existsSync(resolved)) missing.push(`${path.relative(repoRoot, file)} → ${specifier}`);
    }
  }

  assert.deepEqual(missing, [], '这些 import 指到检出不存在的文件（少一级 `..` 会这样）');
  assert.ok(outsideSrc.length > 0, '一个跨仓库 import 都没有？路径正则大概失效了');
});

test('desktop imports all go through app-web (the layer the pin promises)', async () => {
  const files = await sourceFiles(srcRoot);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const specifier of specifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved.startsWith(srcRoot + path.sep)) continue;
      // 手机只 import 桌面的 app-web 与它的资源（图标）；别伸手到 electron / scripts。
      if (!/[/\\]haish-agent[/\\](app-web[/\\]|build[/\\])/.test(resolved)) {
        offenders.push(`${path.relative(repoRoot, file)} → ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
