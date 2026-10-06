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

function declarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(rule, `missing rule: ${selector}`);
  return Object.fromEntries(rule[1].split(';').filter((value) => value.trim()).map((value) => {
    const colon = value.indexOf(':');
    return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
}

test('mobile CodeDiff suppresses automatic text inflation locally, not page zoom', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  const panel = declarations(css, '.aui-tool-detail .haish-tool-elements [data-slot="code-diff"]');
  assert.equal(panel['-webkit-text-size-adjust'], '100%');
  assert.equal(panel['text-size-adjust'], '100%');
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.doesNotMatch(css, /(?:html|body|:root)\s*\{[^}]*text-size-adjust/);
});

test('mobile CodeDiff confines long lines to an intrinsic-width scrolling canvas', async () => {
  const css = await readFile(path.join(repoRoot, 'src', 'styles.css'), 'utf8');
  const panel = '.aui-tool-detail .haish-tool-elements [data-slot="code-diff"]';
  const scroll = declarations(css, `${panel} > div:last-child`);
  assert.equal(scroll['min-width'], '0');
  assert.equal(scroll['max-width'], '100%');
  assert.equal(scroll.overflow, 'auto');
  assert.equal(scroll['max-height'], 'min(56dvh, 520px)');
  const canvas = declarations(css, `${panel} > div:last-child > div`);
  assert.equal(canvas.width, 'max-content');
  assert.equal(canvas['min-width'], '100%');
  const row = declarations(css, `${panel} > div:last-child > div > div`);
  assert.equal(row.display, 'flex');
  assert.equal(row['white-space'], 'pre');
  assert.equal(row['font-size'], '11px');
  assert.match(row['font-family'], /ui-monospace/);
  const spans = declarations(css, `${panel} > div:last-child > div > div > span`);
  assert.equal(spans.flex, '0 0 auto', 'both code text and +/- gutter must keep their full width');
  assert.equal(spans.font, 'inherit', 'comments and statements use the same row typography');
});

test('check:styles verifies the mobile CodeDiff seam in the built bundle', async () => {
  const script = await readFile(path.join(repoRoot, 'scripts', 'verify-bundled-styles.mjs'), 'utf8');
  assert.ok(script.includes('.aui-tool-detail.haish-tool-elements[data-slot=code-diff]{width:100%;max-width:100%;overflow:hidden'));
  assert.ok(script.includes('-webkit-text-size-adjust:100%;text-size-adjust:100%'));
  assert.ok(script.includes('[data-slot=code-diff]>div:last-child>div{width:max-content;min-width:100%}'));
  assert.ok(script.includes('[data-slot=code-diff]>div:last-child>div>div>span{flex:0 0 auto;font:inherit}'));
});
