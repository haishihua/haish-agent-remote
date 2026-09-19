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

/**
 * 一条用户消息「显示上」说的是什么。
 *
 * 带引用的那一轮（桌面与 iOS 都从「Add Comment」进入）在 runtime 落库的正文是
 * 「用户打的字 + 拼给模型看的引用块」（core 的 `app/annotations.py`：一段
 * `Quoted feedback (…)` 加 JSON；只带引用不带正文时整条正文就只剩那一段）。那是给模型
 * 看的；用户打的那几个字 runtime 记在任务的 `display_text` 上（普通轮次是 null），桌面
 * 画气泡用的就是它（AppShell.jsx：`task.displayText ?? task.title`）。手机的行来自消息
 * 本体，所以这里做同一件事：任务摘要上有 `display_text` 就用它，没有才退回消息正文。
 */
export function userMessageText(message, task = null) {
  const display = task?.display_text;
  return chatMessageText(display == null ? message?.content : display);
}

// `textOf` 决定「这一条说的是什么」：传 message 自己那份任务摘要时才认 display_text
// （见 userMessageText；去重与显示必须是同一个刻度，否则注解轮会一直重影）。
export function userMessageOccurrenceCount(messages, text, textOf = userMessageText) {
  const target = String(text || '').trim();
  return (Array.isArray(messages) ? messages : []).filter((message) => (
    message?.role === 'user' && String(textOf(message) || '').trim() === target
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
