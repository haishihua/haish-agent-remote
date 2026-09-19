import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NATIVE_REASONING_HAPTICS, REASONING_HAPTIC_STYLES } from '../src/reasoning-haptics.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reasoning levels map from light through rigid native impacts', () => {
  assert.equal(NATIVE_REASONING_HAPTICS, 'ReasoningHaptics');
  assert.deepEqual(REASONING_HAPTIC_STYLES, ['light', 'medium', 'heavy', 'rigid']);
});

test('the composer opens a four-step reasoning dialog and advanced config omits thinking', async () => {
  const app = await read('../src/App.jsx');
  const runConfigStart = app.indexOf('function RunConfigSheet');
  const runConfigEnd = app.indexOf('\nfunction ', runConfigStart + 20);
  const runConfig = app.slice(runConfigStart, runConfigEnd);

  assert.match(app, /className="sheet-scrim reasoning-sheet-scrim"/);
  assert.match(app, /className="run-config-summary"/);
  assert.match(app, /className=\{`reasoning-slider thinking-\$\{runConfig\.thinking\}`\}/);
  assert.match(app, /setShowReasoningPicker\(false\); setShowRunConfig\(true\)/);
  assert.match(app, /aria-label="Thinking level"/);
  assert.match(app, /impactReasoningStep\(index\)/);
  assert.match(app, /type="range"/);
  assert.doesNotMatch(app, /reasoning-level-labels/);
  assert.doesNotMatch(runConfig, /id: 'thinking'/);
});

test('the native plugin uses progressively stronger UIKit feedback', async () => {
  const [swift, project, delegate, workflow] = await Promise.all([
    read('../ios/App/App/ReasoningHapticsPlugin.swift'),
    read('../ios/App/App.xcodeproj/project.pbxproj'),
    read('../ios/App/App/AppDelegate.swift'),
    read('../.github/workflows/build-ios-unsigned.yml'),
  ]);
  assert.match(swift, /UIImpactFeedbackGenerator\.FeedbackStyle/);
  assert.match(swift, /case "medium"[\s\S]*?\.medium/);
  assert.match(swift, /case "heavy"[\s\S]*?\.heavy/);
  assert.match(swift, /case "rigid"[\s\S]*?\.rigid/);
  assert.match(project, /ReasoningHapticsPlugin\.swift in Sources/);
  assert.match(delegate, /_ = ReasoningHaptics\.self/);
  assert.match(workflow, /assert 'ReasoningHaptics' in classes/);
  assert.match(workflow, /strings \| grep -q ReasoningHaptics/);
});
