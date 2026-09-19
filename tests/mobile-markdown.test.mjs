import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('mobile Markdown keeps desktop Streamdown behavior but disables broken code counters', async () => {
  const [markdown, config, css] = await Promise.all([
    read('../src/mobile-markdown.jsx'),
    read('../vite.config.js'),
    read('../src/styles.css'),
  ]);

  assert.match(markdown, /<Streamdown/);
  assert.match(markdown, /lineNumbers=\{false\}/);
  assert.match(markdown, /plugins=\{plugins\}/);
  assert.match(config, /desktopMarkdownComponent/);
  assert.match(config, /mobileMarkdownComponent/);
  assert.match(css, /code:not\(\[data-streamdown="code-block-body"\] code\)/);
});
