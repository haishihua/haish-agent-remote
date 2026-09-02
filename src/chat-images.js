import { stripChatImageAugmentation } from '../../haish-agent/app-web/src/features/chat/model/chat-text.js';

export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export function chatImageValidationError(file) {
  if (!CHAT_IMAGE_ACCEPTED_MIME.has(String(file?.type || '').toLowerCase())) return 'Unsupported image type.';
  if (Number(file?.size || 0) > CHAT_IMAGE_MAX_BYTES) return 'Image must be 10 MB or smaller.';
  return '';
}

export function messageImageRefs(message, task) {
  const restoredRefs = typeof message?.content === 'string'
    ? stripChatImageAugmentation(message.content).imageRefs
    : [];
  const contentRefs = (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.kind === 'image' || part?.type === 'image' || part?.type === 'image_url')
    .map((part) => ({
      image_id: part.image_id || part.id,
      path: part.path || part.url || part.image_url?.url,
      mime: part.mime || part.mime_type,
    }));
  const seen = new Set();
  return [...contentRefs, ...restoredRefs, ...(task?.image_attachments || [])].filter((ref) => {
    const key = String(ref?.path || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
