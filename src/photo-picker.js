import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './native-connection.js';

/**
 * Name of the app-local iOS plugin (`ios/App/App/PhotoPickerPlugin.swift`). It presents the
 * system photo picker (`PHPickerViewController`) as a half-cover sheet, so one tap on the
 * composer's image button lands in the album grid.
 */
export const NATIVE_PHOTO_PICKER = 'PhotoPicker';

const PHOTO_EXTENSIONS = {
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let photoPicker;

/** The native picker proxy, or null when the app runs in a browser (the file input covers that). */
export function nativePhotoPicker() {
  if (!isNativeApp) return null;
  if (!photoPicker) photoPicker = registerPlugin(NATIVE_PHOTO_PICKER);
  return photoPicker;
}

export function hasNativePhotoPicker() {
  return Boolean(nativePhotoPicker());
}

export function remainingImageSlots(count, maxCount) {
  const total = Math.max(0, Math.floor(Number(maxCount) || 0));
  const used = Math.max(0, Math.floor(Number(count) || 0));
  return Math.max(0, total - used);
}

export function pickedPhotoType(photo, blobType) {
  const types = [blobType, photo?.mime, photo?.type]
    .map((value) => String(value || '').toLowerCase().split(';')[0].trim())
    .filter((value) => value.startsWith('image/'));
  return types[0] || 'image/jpeg';
}

export function pickedPhotoName(photo, type, index = 0) {
  const name = String(photo?.name || '').split('/').pop().trim();
  if (name) return name;
  const extension = PHOTO_EXTENSIONS[type] || PHOTO_EXTENSIONS['image/jpeg'];
  return `photo-${Date.now()}-${index + 1}.${extension}`;
}

/**
 * Turns the native picker payload (`{ path, webPath, name }`) into files the composer can upload.
 * Photos that fail to load are skipped so a single bad asset never blocks the rest.
 */
export async function pickedPhotoFiles(photos, { fetchImpl = fetch } = {}) {
  const files = [];
  const list = Array.isArray(photos) ? photos : [];
  for (let index = 0; index < list.length; index += 1) {
    const photo = list[index];
    const url = String(photo?.webPath || photo?.path || '').trim();
    if (!url) continue;
    let blob;
    try {
      const response = await fetchImpl(url);
      blob = await response.blob();
    } catch {
      continue;
    }
    if (!blob?.size) continue;
    const type = pickedPhotoType(photo, blob.type);
    files.push(new File([blob], pickedPhotoName(photo, type, index), { type }));
  }
  return files;
}

export function isUnimplementedError(error) {
  return String(error?.code || '').toUpperCase() === 'UNIMPLEMENTED';
}

/**
 * `window.Capacitor.nativePromise(name, method, options)` from the native bridge. Unlike the
 * `registerPlugin()` proxy it does not need the plugin to be present in the JavaScript headers:
 * the bridge resolves a missing plugin class by name when the call arrives
 * (`CapacitorBridge.handleJSCall`), so this is the fallback for an app-local plugin that the
 * generated `packageClassList` missed (see `scripts/sync-ios-app-plugins.mjs`).
 */
export function nativeBridgePromise(capacitor = globalThis.Capacitor) {
  const invoke = capacitor?.nativePromise;
  return typeof invoke === 'function' ? invoke.bind(capacitor) : null;
}

/** The picker's `limit` is a slot count, never a negative or fractional one. */
export function pickerOptions(limit) {
  return { limit: Math.max(0, Math.floor(Number(limit) || 0)) };
}

/**
 * Runs one picker call and turns the picked assets into uploadable files. A missing registration
 * makes the proxy reject with UNIMPLEMENTED before any native code runs, so that specific error
 * retries straight through the bridge instead of dropping to the file input.
 */
export async function pickImagesWith(picker, { limit, fetchImpl, nativePromise } = {}) {
  const options = pickerOptions(limit);
  let result;
  try {
    result = await picker.pickImages(options);
  } catch (error) {
    if (!isUnimplementedError(error)) throw error;
    const invoke = nativePromise || nativeBridgePromise();
    if (!invoke) throw error;
    result = await invoke(NATIVE_PHOTO_PICKER, 'pickImages', options);
  }
  return pickedPhotoFiles(result?.photos, { fetchImpl });
}

/**
 * Opens the system photo picker and resolves with the picked files (possibly empty).
 * Throws `{ code: 'cancelled' }` when the user closes the sheet without picking anything.
 * Resolves with `null` when the native picker is unavailable, so callers fall back to the
 * `<input type="file">` sheet.
 */
export async function pickImagesFromLibrary({ limit, fetchImpl } = {}) {
  const picker = nativePhotoPicker();
  if (!picker) return null;
  return pickImagesWith(picker, { limit, fetchImpl });
}

export function isPhotoPickerCancellation(error) {
  const code = String(error?.code || '').toLowerCase();
  if (code === 'cancelled' || code === 'canceled') return true;
  return /cancel|no photo was picked/i.test(String(error?.message || ''));
}
