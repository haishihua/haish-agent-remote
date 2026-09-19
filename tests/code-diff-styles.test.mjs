import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DIFF_PANEL = '.aui-tool-detail .haish-tool-elements [data-slot="code-diff"] { width: 100%; max-width: 100%; overflow: hidden;';

test('mobile CodeDiff keeps the desktop component but adds a complete narrow-screen panel', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(DIFF_PANEL), 'CodeDiff should have a bordered full-width mobile panel');
  assert.ok(css.includes('[data-slot="code-diff"] > div:first-child'), 'CodeDiff should retain a distinct filename header');
  assert.ok(css.includes('[data-slot="code-diff"] > div:last-child { max-height:'), 'long diffs should scroll inside the panel');
  assert.ok(css.includes('[data-slot="code-diff"] > div:last-child > div > div { min-height:'), 'diff rows should have stable density and separators');
});

test('check:styles verifies the mobile CodeDiff seam in the built bundle', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(script.includes('.aui-tool-detail.haish-tool-elements[data-slot=code-diff]{width:100%;max-width:100%;overflow:hidden'));
});
