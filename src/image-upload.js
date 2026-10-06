import { chatImageValidationError } from './chat-images.js';

export const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

/** Never silently turn a message with selected attachments into a text-only send. */
export function hasBlockedImageUploads(images) {
  return images.some((image) => image.uploading || image.error || !image.imageId || !image.path);
}

export function imageUploadErrorMessage(error, timedOut = false) {
  const status = error?.status ?? error?.requestDiagnostic?.status;
  if (timedOut) return 'Image upload timed out. Retry or remove the image.';
  if (status === 401 || status === 403) return 'Image upload was not authorized. Reconnect and try again.';
  if (status === 413) return 'Image is too large to upload. Remove it and choose a smaller image.';
  return 'Image upload failed. Retry or remove the image.';
}

/** Share initial upload and manual retry, and ignore removed/unmounted draft responses. */
export function createImageUploader({ getImages, setImages, uploadFile, timeoutMs = IMAGE_UPLOAD_TIMEOUT_MS }) {
  const requests = new Map();

  function patch(id, changes) {
    const images = getImages();
    if (!images.some((image) => image.id === id)) return;
    setImages(images.map((image) => image.id === id ? { ...image, ...changes } : image));
  }

  function upload(id) {
    const pending = requests.get(id);
    if (pending) return pending.promise;
    const image = getImages().find((item) => item.id === id);
    if (!image || image.imageId || chatImageValidationError(image.file)) return Promise.resolve();
    const controller = new AbortController();
    const request = { controller, promise: null };
    requests.set(id, request);
    patch(id, { uploading: true, error: '', retryable: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    request.promise = (async () => {
      try {
        const result = await uploadFile(image.file, { signal: controller.signal });
        if (!result?.image_id || !result?.path) throw new Error('Invalid image upload response');
        if (requests.get(id) !== request) return;
        patch(id, { uploading: false, error: '', retryable: false,
          imageId: result.image_id, path: result.path, mime: result.mime });
      } catch (error) {
        if (requests.get(id) !== request) return;
        patch(id, { uploading: false, error: imageUploadErrorMessage(error, timedOut), retryable: true });
      } finally {
        clearTimeout(timer);
        if (requests.get(id) === request) requests.delete(id);
      }
    })();
    return request.promise;
  }

  function cancel(id) {
    const request = requests.get(id);
    requests.delete(id);
    request?.controller.abort();
  }

  return { upload, cancel, cancelAll() { for (const id of requests.keys()) cancel(id); } };
}
