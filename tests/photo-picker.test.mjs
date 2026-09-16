import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATIVE_PHOTO_PICKER,
  hasNativePhotoPicker,
  isPhotoPickerCancellation,
  isUnimplementedError,
  nativeBridgePromise,
  nativePhotoPicker,
  pickImagesFromLibrary,
  pickImagesWith,
  pickedPhotoFiles,
  pickedPhotoName,
  pickedPhotoType,
  pickerOptions,
  remainingImageSlots,
} from '../src/photo-picker.js';

const photo = (overrides = {}) => ({ name: 'haish-photo-1.jpg', webPath: 'capacitor://localhost/_capacitor_file_/tmp/haish-photo-1.jpg', ...overrides });

const blobFetch = (body = 'photo', type = 'image/jpeg') => async () => ({
  blob: async () => new Blob([body], { type }),
});

test('the native picker stays off in a browser so the file input keeps working', async () => {
  assert.equal(NATIVE_PHOTO_PICKER, 'PhotoPicker');
  assert.equal(hasNativePhotoPicker(), false);
  assert.equal(nativePhotoPicker(), null);
  assert.equal(await pickImagesFromLibrary({ limit: 4 }), null);
});

test('the picker limit never exceeds the free composer slots', () => {
  assert.equal(remainingImageSlots(0, 4), 4);
  assert.equal(remainingImageSlots(3, 4), 1);
  assert.equal(remainingImageSlots(4, 4), 0);
  assert.equal(remainingImageSlots(9, 4), 0);
  assert.equal(remainingImageSlots(undefined, undefined), 0);
});

test('picked photos become uploadable files named after the asset', async () => {
  const files = await pickedPhotoFiles([photo({ name: 'IMG_0042.JPG' })], { fetchImpl: blobFetch() });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'IMG_0042.JPG');
  assert.equal(files[0].type, 'image/jpeg');
  assert.equal(await files[0].text(), 'photo');
});

test('a photo without a name falls back to the blob type extension', async () => {
  const files = await pickedPhotoFiles(
    [photo({ name: '', webPath: 'capacitor://localhost/_capacitor_file_/tmp/haish-photo-2' })],
    { fetchImpl: blobFetch('png-bytes', 'image/png') },
  );
  assert.equal(files[0].type, 'image/png');
  assert.match(files[0].name, /^photo-\d+-1\.png$/);
  assert.match(pickedPhotoName({}, 'image/webp'), /^photo-\d+-1\.webp$/);
  assert.match(pickedPhotoName({}, 'application/octet-stream'), /^photo-\d+-1\.jpg$/);
});

test('blob mime wins over a missing type hint and unknown types fall back to jpeg', () => {
  assert.equal(pickedPhotoType({}, 'image/heic'), 'image/heic');
  assert.equal(pickedPhotoType({ mime: 'image/png' }, ''), 'image/png');
  assert.equal(pickedPhotoType({}, 'application/octet-stream'), 'image/jpeg');
  assert.equal(pickedPhotoType({ type: 'IMAGE/JPEG; charset=binary' }, ''), 'image/jpeg');
});

test('unreadable photos are skipped instead of failing the whole selection', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('broken')) throw new Error('file is gone');
    if (String(url).includes('empty')) return { blob: async () => new Blob([]) };
    return { blob: async () => new Blob(['ok'], { type: 'image/jpeg' }) };
  };
  const files = await pickedPhotoFiles([
    { name: 'broken.jpg', webPath: 'capacitor://localhost/_capacitor_file_/broken.jpg' },
    { name: 'empty.jpg', webPath: 'capacitor://localhost/_capacitor_file_/empty.jpg' },
    { name: 'good.jpg', webPath: 'capacitor://localhost/_capacitor_file_/good.jpg' },
    { name: 'no-url.jpg' },
  ], { fetchImpl });
  assert.deepEqual(files.map((file) => file.name), ['good.jpg']);
});

test('pickedPhotoFiles tolerates an empty or malformed payload', async () => {
  assert.deepEqual(await pickedPhotoFiles(undefined, { fetchImpl: blobFetch() }), []);
  assert.deepEqual(await pickedPhotoFiles([], { fetchImpl: blobFetch() }), []);
  assert.deepEqual(await pickedPhotoFiles([null, undefined], { fetchImpl: blobFetch() }), []);
});

test('closing the sheet without picking is treated as a cancel, real errors are not', () => {
  assert.equal(isPhotoPickerCancellation({ code: 'cancelled' }), true);
  assert.equal(isPhotoPickerCancellation({ code: 'canceled' }), true);
  assert.equal(isPhotoPickerCancellation(new Error('No photo was picked.')), true);
  assert.equal(isPhotoPickerCancellation({ message: 'User cancelled photos app' }), true);
  assert.equal(isPhotoPickerCancellation({ code: 'UNIMPLEMENTED', message: 'not implemented' }), false);
  assert.equal(isPhotoPickerCancellation(undefined), false);
});

test('the bridge fallback only exists when the native bridge exposes nativePromise', () => {
  assert.equal(nativeBridgePromise(undefined), null);
  assert.equal(nativeBridgePromise({}), null);
  assert.equal(nativeBridgePromise({ nativePromise: 'not a function' }), null);
  const invoke = (name, method, options) => ({ name, method, options });
  const call = nativeBridgePromise({ nativePromise: invoke });
  assert.deepEqual(call(NATIVE_PHOTO_PICKER, 'pickImages', { limit: 1 }), {
    name: 'PhotoPicker',
    method: 'pickImages',
    options: { limit: 1 },
  });
});

test('the picker options only ever carry a whole slot count', () => {
  assert.deepEqual(pickerOptions(3.9), { limit: 3 });
  assert.deepEqual(pickerOptions(-2), { limit: 0 });
  assert.deepEqual(pickerOptions(undefined), { limit: 0 });
  assert.equal(isUnimplementedError({ code: 'unimplemented' }), true);
  assert.equal(isUnimplementedError(new Error('not implemented')), false);
  assert.equal(isUnimplementedError(undefined), false);
});

test('an unregistered plugin retries through the bridge instead of the file input', async () => {
  const calls = [];
  const picker = {
    async pickImages(options) {
      calls.push(['proxy', options]);
      throw { code: 'UNIMPLEMENTED', message: '"PhotoPicker" plugin is not implemented on ios' };
    },
  };
  const nativePromise = async (name, method, options) => {
    calls.push([name, method, options]);
    return { photos: [photo()] };
  };
  const files = await pickImagesWith(picker, { limit: 2.4, fetchImpl: blobFetch(), nativePromise });
  assert.deepEqual(calls, [
    ['proxy', { limit: 2 }],
    [NATIVE_PHOTO_PICKER, 'pickImages', { limit: 2 }],
  ]);
  assert.deepEqual(files.map((file) => file.name), ['haish-photo-1.jpg']);
});

test('cancels and real failures never touch the bridge fallback', async () => {
  const nativePromise = async () => { throw new Error('the bridge must not be called'); };
  await assert.rejects(
    () => pickImagesWith({ pickImages: async () => { throw { code: 'cancelled' }; } }, { nativePromise }),
    (error) => error.code === 'cancelled',
  );
  await assert.rejects(
    () => pickImagesWith({ pickImages: async () => { throw new Error('photos are broken'); } }, { nativePromise, fetchImpl: blobFetch() }),
    /photos are broken/,
  );
});

test('without a bridge global the original unimplemented error is rethrown', async () => {
  const previous = globalThis.Capacitor;
  delete globalThis.Capacitor;
  try {
    const error = Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' });
    await assert.rejects(
      () => pickImagesWith({ pickImages: async () => { throw error; } }, { fetchImpl: blobFetch() }),
      (thrown) => thrown === error,
    );
  } finally {
    if (previous !== undefined) globalThis.Capacitor = previous;
  }
});
