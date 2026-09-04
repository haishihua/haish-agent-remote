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

export function chatMessageText(content) {
  const raw = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
      .map((part) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n');
  return stripChatImageAugmentation(raw).text;
}

export function userMessageOccurrenceCount(messages, text) {
  const target = String(text || '').trim();
  return (Array.isArray(messages) ? messages : []).filter((message) => (
    message?.role === 'user' && chatMessageText(message.content).trim() === target
  )).length;
}

export function messageWithImageAttachments(message, imageAttachments) {
  const paths = (Array.isArray(imageAttachments) ? imageAttachments : [])
    .map((image) => String(image?.path || '').trim())
    .filter(Boolean);
  if (!paths.length) return String(message || '');
  const markers = paths.map((path, index) => `[user attached image #${index + 1}: ${path}]`).join('\n');
  const hint = 'The user attached the image(s) above. Inspect the image files before answering; do not infer their contents from filenames.';
  return [String(message || '').trim(), markers, hint].filter(Boolean).join('\n\n');
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
