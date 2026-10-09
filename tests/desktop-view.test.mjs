import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopViewSize } from '../src/desktop-view.js';

test('fit and zoom preserve native desktop aspect without distorting or hiding edges at 1x', () => {
  for (const [vw, vh] of [[369, 409], [660, 321], [320, 560]]) {
    const fit = desktopViewSize(vw, vh, 2940, 1912, 1);
    assert.ok(fit.width <= vw && fit.height <= vh);
    assert.ok(Math.abs(fit.width / fit.height - 2940 / 1912) < 1e-10);
    const zoom = desktopViewSize(vw, vh, 2940, 1912, 1.5);
    assert.equal(zoom.width, fit.width * 1.5);
    assert.equal(zoom.height, fit.height * 1.5);
  }
});

test('unmeasured video uses neutral ratio; resized view recomputes fitted size', () => {
  assert.deepEqual(desktopViewSize(320, 500, undefined, undefined, 1), { width: 320, height: 200 });
  const fit = desktopViewSize(800, 300, 1920, 1080, 1);
  assert.ok(Math.abs(fit.width - 300 * 1920 / 1080) < 1e-10);
  assert.equal(fit.height, 300);
});
