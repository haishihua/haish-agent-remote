#!/usr/bin/env node
/**
 * Register the Capacitor plugins that live in the iOS App target.
 *
 * `npx cap sync` only knows about plugins that ship as npm packages: the CLI scans their iOS
 * sources for `@objc(Name)` and writes the result into the generated
 * `ios/App/App/capacitor.config.json` as `packageClassList`. The bridge registers exactly those
 * classes at startup and exports their JavaScript headers, so a class that is not on the list is
 * unreachable from the web layer: `registerPlugin(name)` rejects with UNIMPLEMENTED before any
 * native code is called, even when the class is linked into the app binary.
 *
 * App-local plugins (`ios/App/App/*.swift`) are invisible to that scan, and `cap sync`
 * regenerates the config on every build, so this step runs right after it and appends the
 * app-local classes to the same list.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const APP_TARGET_DIR = join('ios', 'App', 'App');
export const GENERATED_CONFIG_PATH = join(APP_TARGET_DIR, 'capacitor.config.json');

/** The same pattern `@capacitor/cli` uses to find plugin classes (`util/iosplugin.js`). */
const OBJC_NAME = /@objc\(([A-Za-z0-9_-]+)\)/;

/**
 * Class names of the app-local plugins: Swift files in the App target that bridge to JavaScript.
 * Files without `CAPBridgedPlugin` are ignored, so unrelated `@objc(...)` attributes are safe.
 */
export function findAppLocalPluginClasses(directory, {
  readDirectory = readdirSync,
  readFile = readFileSync,
} = {}) {
  const classes = [];
  for (const entry of [...readDirectory(directory)].sort()) {
    if (!entry.endsWith('.swift')) continue;
    const source = readFile(join(directory, entry), 'utf8');
    if (!source.includes('CAPBridgedPlugin')) continue;
    const match = OBJC_NAME.exec(source);
    if (!match) {
      throw new Error(`${entry} bridges to JavaScript (CAPBridgedPlugin) but has no @objc(Name) attribute`);
    }
    if (!classes.includes(match[1])) classes.push(match[1]);
  }
  return classes;
}

/** Adds the app-local classes to the list the CLI generated, keeping its entries and order. */
export function withPackageClassList(config, classNames) {
  const list = Array.isArray(config?.packageClassList) ? [...config.packageClassList] : [];
  for (const name of classNames) {
    if (!list.includes(name)) list.push(name);
  }
  return { ...config, packageClassList: list };
}

/**
 * Rewrites the generated native config so the bridge registers the app-local plugins too.
 * Returns the resulting class list.
 */
export function registerAppPlugins({ root = ROOT, log = console.log } = {}) {
  const configPath = join(root, GENERATED_CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new Error(`${GENERATED_CONFIG_PATH} is missing; run \`npx cap sync\` before this step`);
  }
  const classNames = findAppLocalPluginClasses(join(root, APP_TARGET_DIR));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const next = withPackageClassList(config, classNames);
  const changed = JSON.stringify(next.packageClassList) !== JSON.stringify(config.packageClassList ?? null);
  writeFileSync(configPath, `${JSON.stringify(next, null, '\t')}\n`);
  const found = classNames.length ? classNames.join(', ') : '(none)';
  log(`ios: app-local Capacitor plugins ${found} -> ${GENERATED_CONFIG_PATH}${changed ? ' (registered)' : ' (already registered)'}`);
  return next.packageClassList;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    registerAppPlugins();
  } catch (error) {
    console.error(`ios: ${error.message}`);
    process.exitCode = 1;
  }
}
