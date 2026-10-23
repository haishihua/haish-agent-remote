// 手机端的 chat 线程：直接渲染桌面的行与时间线组件（ChatMessageRow →
// ChatAgentTimeline → 工具卡 / 审批卡 / 提问卡 / todo / 活动 orb）。
//
// 这里只补两件桌面端不需要的事：
//   1) 图片：桌面行只画 `previewUrl`，而桌面的 previewUrl 是同源 HTTP 直链；
//      手机要带鉴权去 runtime 取 blob（api.imagePreview），所以先落到 object URL
//      再交给行；没取到之前不占位（宁可晚一帧出现，也不要一个裂图按钮）。
//   2) 执行记录按需加载：历史轮次的 eventLog 只有滚到眼前才值得下载。桌面端自己
//      在滚动加载更早的轮次，手机这边用 IntersectionObserver 触发（行上会说
//      「Steps load when you scroll up.」）。
import React from 'react';
// 桌面那几份带前缀的全局样式段（chat / approvals / workflow-runtime / delegation）
// 和 base.css 摘出来的 token：桌面组件自己只 import 组件级样式，这几段得由这一层
// 带进模块图。顺序上它排在 main.jsx 的 styles.css 之前（App.jsx 先被 import），
// 所以两边同名的 token 和类名由手机这边说了算。
import './desktop-theme.css';
import { ChatMessageRow } from '../../haish-agent/app-web/src/features/chat/components/ChatMessageRow.jsx';
import { api } from './api.js';
import { resolveTranscriptImages, transcriptImageRefs } from './transcript-images.js';

const IMAGE_URLS = new Map(); // `${conversationId}\u0000${path}` → object URL
const IMAGE_FAILURES = new Set();
const IMAGE_REQUESTS = new Map();
const RESOLVED_IMAGES = new WeakMap();

function imageUrlKey(conversationId, path) {
  return `${conversationId}\u0000${path}`;
}

/** 切会话时把上一段的 object URL 放掉（会话详情卸载/切换都会走这里）。 */
export function releaseConversationImageUrls(conversationId) {
  const prefix = `${conversationId}\u0000`;
  for (const [key, url] of IMAGE_URLS) {
    if (!key.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    IMAGE_URLS.delete(key);
  }
  for (const key of IMAGE_FAILURES) {
    if (key.startsWith(prefix)) IMAGE_FAILURES.delete(key);
  }
}

// 一个 path 只问一次 runtime：并发（StrictMode 双跑、多行同图）都挂在同一个 promise 上。
function loadImageUrl(conversationId, path, onReady) {
  const key = imageUrlKey(conversationId, path);
  if (IMAGE_URLS.has(key) || IMAGE_FAILURES.has(key)) return;
  if (IMAGE_REQUESTS.has(key)) return;
  const request = api.imagePreview(conversationId, path)
    .then((blob) => {
      IMAGE_URLS.set(key, URL.createObjectURL(blob));
      onReady?.();
    })
    .catch(() => {
      // 取不到就当作没有这张图（附件的本体仍在 runtime 里，桌面端能看到）。
      IMAGE_FAILURES.add(key);
    })
    .finally(() => {
      IMAGE_REQUESTS.delete(key);
    });
  IMAGE_REQUESTS.set(key, request);
}

function resolveImage(conversationId, image) {
  const path = String(image?.path || '');
  if (!path) return null;
  const url = IMAGE_URLS.get(imageUrlKey(conversationId, path));
  if (!url) return null;
  const previous = RESOLVED_IMAGES.get(image);
  if (previous?.previewUrl === url) return previous;
  const resolved = { ...image, previewUrl: url };
  RESOLVED_IMAGES.set(image, resolved);
  return resolved;
}

// 图片还没到位时整张图先不出现（行只认 previewUrl）。
function applyImageUrls(row, conversationId) {
  const images = Array.isArray(row.images) ? row.images : [];
  const resolve = (image) => resolveImage(conversationId, image);
  const resolved = images.map(resolve).filter(Boolean);
  const traceTimeline = resolveTranscriptImages(row.traceTimeline, resolve);
  if (traceTimeline === row.traceTimeline && resolved.length === images.length
    && resolved.every((image, index) => image === images[index])) return row;
  return { ...row, images: resolved, traceTimeline };
}

const ROW_KEYS = [
  'id', 'taskId', 'conversationId', 'messageId', 'role', 'agentName', 'text', 'status',
  'streaming', 'createdAt', 'completedAt', 'firstTokenAt', 'traceHydrated', 'traceLatestTodos',
];

function sameImages(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((image, index) => image?.image_id === b[index]?.image_id
    && image?.path === b[index]?.path
    && image?.previewUrl === b[index]?.previewUrl);
}

// 引用批注（桌面的「添加注释」）每次轮询都是新解出来的对象，但内容一样时行不能换身份，
// 否则整行（含 Markdown）跟着重画一次。
function sameAnnotations(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item?.id === b[index]?.id
    && item?.text === b[index]?.text
    && item?.comment === b[index]?.comment
    && item?.start === b[index]?.start
    && item?.end === b[index]?.end
    && item?.source_message_id === b[index]?.source_message_id);
}

function sameRow(previous, next) {
  if (!previous) return false;
  // `annotations` 不在 ROW_KEYS 里，按内容单独比（见 sameAnnotations）。
  if (!sameAnnotations(previous.annotations, next.annotations)) return false;
  if (!ROW_KEYS.every((key) => previous[key] === next[key])) return false;
  if ((previous.progressLines || []).length !== (next.progressLines || []).length) return false;
  if (previous.traceTimeline !== next.traceTimeline) return false;
  return sameImages(previous.images, next.images);
}

/**
 * 行对象复用：每来一个流事件 App 都会重建一次行列表，而行组件是按 message 的
 * **对象身份**做 memo 的。内容没变的行换回上一个对象，上面那些 Markdown / 工具卡
 * 才不会被每帧重画一遍（桌面的 AppShell 也是这么干的）。
 */
export function stabilizeRows(cache, rows) {
  const seen = new Set();
  const stable = rows.map((row) => {
    seen.add(row.id);
    const previous = cache.get(row.id);
    if (sameRow(previous, row)) return previous;
    cache.set(row.id, row);
    return row;
  });
  for (const id of [...cache.keys()]) {
    if (!seen.has(id)) cache.delete(id);
  }
  return stable;
}

function ChatThreadComponent({ conversationId = '', rows = [], loadTaskTrace, annotationNumbers = null, onPreviewImage, onAnnotationJump, onRetryTask = null, retryableTaskId = '', retryPendingTaskId = '', retryBlocked = false }) {
  const rowCacheRef = React.useRef(new Map());
  const viewCacheRef = React.useRef(new Map());
  const [imageVersion, bumpImageVersion] = React.useReducer((value) => value + 1, 0);
  const observerRef = React.useRef(null);
  const observerRowsRef = React.useRef(new Set());
  const requestedTracesRef = React.useRef(new Set());

  const baseRows = React.useMemo(() => stabilizeRows(rowCacheRef.current, rows), [rows]);
  const withImages = React.useMemo(
    () => baseRows.map((row) => applyImageUrls(row, conversationId)),
    [baseRows, conversationId, imageVersion],
  );
  const viewRows = React.useMemo(
    () => stabilizeRows(viewCacheRef.current, withImages),
    [withImages],
  );

  // 图片按需取：先扫一遍要哪几张，effect 里发起（render 阶段不碰网络）。
  const pendingImages = [];
  for (const row of baseRows) {
    for (const image of [...(row.images || []), ...transcriptImageRefs(row)]) {
      const path = String(image?.path || '');
      if (!path) continue;
      const key = imageUrlKey(conversationId, path);
      if (IMAGE_URLS.has(key) || IMAGE_FAILURES.has(key)) continue;
      pendingImages.push(path);
    }
  }
  React.useEffect(() => {
    for (const path of pendingImages) loadImageUrl(conversationId, path, bumpImageVersion);
  });

  // 执行记录按需加载：行滚进视野（含下方 240px 预取区）才去问 runtime。
  React.useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !loadTaskTrace) return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const taskId = entry.target.getAttribute('data-trace-task-id') || '';
        if (taskId) loadTaskTrace(taskId);
      }
    }, { rootMargin: '240px 0px' });
    observerRef.current = observer;
    for (const node of observerRowsRef.current) observer.observe(node);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [loadTaskTrace]);

  const attachRow = React.useCallback((node, taskId) => {
    if (!node || !taskId) return;
    if (requestedTracesRef.current.has(taskId)) return;
    requestedTracesRef.current.add(taskId);
    node.setAttribute('data-trace-task-id', taskId);
    observerRowsRef.current.add(node);
    observerRef.current?.observe(node);
  }, []);

  return viewRows.map((row) => {
    const needsTrace = row.role === 'agent' && row.traceHydrated === false && row.taskId;
    // Retry 只给「这个会话的最后一轮、状态 failed」那一行：runtime 的 `rerun` 也只接
    // 这种任务，其余失败行保持桌面那颗带 title 提示的禁用按钮（ErrorState 自己画）。
    const retryable = Boolean(onRetryTask) && row.role === 'agent' && row.status === 'failed'
      && row.taskId && row.taskId === retryableTaskId;
    return (
      <div className="chat-row" key={row.id}>
        <ChatMessageRow
          message={row}
          annotationNumbers={annotationNumbers || undefined}
          onAnnotationJump={onAnnotationJump}
          onPreviewImage={onPreviewImage}
          onRetry={retryable ? onRetryTask : undefined}
          retryPending={Boolean(retryPendingTaskId) && row.taskId === retryPendingTaskId}
          actionsDisabled={Boolean(row.streaming) || retryBlocked}
        />
        {needsTrace ? <span ref={(node) => attachRow(node, row.taskId)} aria-hidden="true" /> : null}
      </div>
    );
  });
}

// Composer keystrokes update ConversationDetail, but they do not change this subtree. Keeping the
// boundary here prevents a long Markdown/tool timeline from being traversed for every character.
export const ChatThread = React.memo(ChatThreadComponent);
