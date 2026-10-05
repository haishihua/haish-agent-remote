import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Compile the actual component and render its three startup states without
// contacting the adapter or changing the device's connectivity.
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import ConnectionScreen from './src/ConnectionScreen.jsx';
      export const render = props => renderToStaticMarkup(React.createElement(ConnectionScreen, props));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  loader: { '.png': 'dataurl' },
  write: false,
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(require, compiled, compiled.exports);
const { render } = compiled.exports;

test('startup matches the design labels without a Mac model or Chinese loading copy', () => {
  const html = render({ error: '', retrying: true });
  assert.match(html, /Connecting to Haish/);
  assert.match(html, /Connecting…/);
  assert.match(html, /This iPhone/);
  assert.match(html, /connection-spinner/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /MacBook|正在连接|Secure connection|Try again/);
});

test('failed startup retains a manual retry and a truthful paused status', () => {
  const html = render({ error: 'offline', retrying: false, onRetry() {} });
  assert.match(html, /Can’t reach your computer/);
  assert.match(html, /Connection paused/);
  assert.match(html, /Try again/);
  assert.match(html, /aria-busy="false"/);
  assert.doesNotMatch(html, /connection-spinner|disabled=""/);
});

test('retry in flight shows progress and disables the retry button', () => {
  const html = render({ error: 'offline', retrying: true, onRetry() {} });
  assert.match(html, /Trying again…/);
  assert.match(html, /connection-spinner/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
});

test('startup typography inherits WenKai for brand and heading; motion and small screens have fallbacks', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--conversation-font: "LXGW WenKai Screen"/);
  assert.match(css, /\.connection-screen \{[^}]*font-family: var\(--conversation-font\)/);
  for (const selector of ['connection-brand span', 'connection-panel h1']) {
    const rule = css.split(`.${selector} {`)[1].split('}')[0];
    assert.match(rule, /font-family: inherit/);
  }
  assert.match(css, /@media \(max-height: 650px\)/);
  assert.match(css, /\.connection-spinner, \.connection-route b > span \{ animation: none; \}/);
});
