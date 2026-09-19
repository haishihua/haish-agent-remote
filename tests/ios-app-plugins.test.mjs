import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APP_TARGET_DIR,
  GENERATED_CONFIG_PATH,
  findAppLocalPluginClasses,
  registerAppPlugins,
  withPackageClassList,
} from '../scripts/sync-ios-app-plugins.mjs';
import { NATIVE_PHOTO_PICKER } from '../src/photo-picker.js';
import { NATIVE_REASONING_HAPTICS } from '../src/reasoning-haptics.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

function fixtureRoot({ swiftFiles = {}, config = { packageClassList: ['SecureStorage'] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'haish-ios-plugins-'));
  mkdirSync(join(root, APP_TARGET_DIR), { recursive: true });
  for (const [name, source] of Object.entries(swiftFiles)) {
    writeFileSync(join(root, APP_TARGET_DIR, name), source);
  }
  if (config) writeFileSync(join(root, GENERATED_CONFIG_PATH), `${JSON.stringify(config, null, '\t')}\n`);
  return root;
}

test('only Swift files that bridge to JavaScript are registered', () => {
  const classes = findAppLocalPluginClasses(join(REPO_ROOT, APP_TARGET_DIR));
  assert.deepEqual(classes, [NATIVE_PHOTO_PICKER, NATIVE_REASONING_HAPTICS]);
});

test('@objc names of files without CAPBridgedPlugin are ignored', () => {
  const source = (name, extra) => `@objc(${name})\npublic class ${name}: CAPPlugin, ${extra}\n`;
  const classes = findAppLocalPluginClasses('ignored', {
    readDirectory: () => ['AppDelegate.swift', 'Helper.swift', 'NotAPlugin.swift', 'PhotoPickerPlugin.swift'],
    readFile: (path) => {
      if (path.endsWith('PhotoPickerPlugin.swift')) return source('PhotoPicker', 'CAPBridgedPlugin');
      if (path.endsWith('NotAPlugin.swift')) return source('NotAPlugin', 'NSObject');
      if (path.endsWith('Helper.swift')) return '@objc(HaishHelper)\nstruct HaishHelper {}\n';
      return 'import UIKit\n@UIApplicationMain\nclass AppDelegate: UIResponder {}\n';
    },
  });
  assert.deepEqual(classes, ['PhotoPicker']);
});

test('a bridged class without an @objc name fails the build instead of silently missing', () => {
  assert.throws(
    () => findAppLocalPluginClasses('ignored', {
      readDirectory: () => ['BrokenPlugin.swift'],
      readFile: () => 'public class BrokenPlugin: CAPPlugin, CAPBridgedPlugin {}\n',
    }),
    /BrokenPlugin\.swift.*@objc/,
  );
});

test('the generated packageClassList keeps the CLI entries and gains the app-local ones', () => {
  assert.deepEqual(
    withPackageClassList({ packageClassList: ['SecureStorage', 'CapacitorBarcodeScannerPlugin'] }, ['PhotoPicker', 'ReasoningHaptics']).packageClassList,
    ['SecureStorage', 'CapacitorBarcodeScannerPlugin', 'PhotoPicker', 'ReasoningHaptics'],
  );
  assert.deepEqual(withPackageClassList({}, ['PhotoPicker']).packageClassList, ['PhotoPicker']);
  assert.deepEqual(withPackageClassList({ appId: 'x', packageClassList: ['PhotoPicker'] }, ['PhotoPicker']).packageClassList, ['PhotoPicker']);
  assert.equal(withPackageClassList({ packageClassList: ['A'] }, []).appId, undefined);
  assert.equal(withPackageClassList({ appId: 'x' }, []).appId, 'x');
});

test('registering rewrites the generated native config and stays idempotent', () => {
  const root = fixtureRoot({
    swiftFiles: { 'PhotoPickerPlugin.swift': '@objc(PhotoPicker)\npublic class PhotoPicker: CAPPlugin, CAPBridgedPlugin {}\n' },
    config: { appId: 'com.haish.agent.remote', packageClassList: ['SecureStorage'] },
  });
  const first = registerAppPlugins({ root, log: () => {} });
  assert.deepEqual(first, ['SecureStorage', 'PhotoPicker']);
  const written = JSON.parse(readFileSync(join(root, GENERATED_CONFIG_PATH), 'utf8'));
  assert.equal(written.appId, 'com.haish.agent.remote');
  assert.deepEqual(written.packageClassList, ['SecureStorage', 'PhotoPicker']);
  assert.deepEqual(registerAppPlugins({ root, log: () => {} }), ['SecureStorage', 'PhotoPicker']);
});

test('a missing generated config fails loudly, an app without app-local plugins still syncs', () => {
  const missing = mkdtempSync(join(tmpdir(), 'haish-ios-plugins-'));
  mkdirSync(join(missing, APP_TARGET_DIR), { recursive: true });
  assert.throws(() => registerAppPlugins({ root: missing, log: () => {} }), /npx cap sync/);

  const empty = fixtureRoot({ swiftFiles: { 'AppDelegate.swift': 'class AppDelegate {}\n' } });
  assert.deepEqual(registerAppPlugins({ root: empty, log: () => {} }), ['SecureStorage']);
  assert.equal(existsSync(join(REPO_ROOT, 'scripts/sync-ios-app-plugins.mjs')), true);
});
