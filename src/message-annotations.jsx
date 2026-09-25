// 手机端的「添加到聊天」：桌面「添加注释」那套（app-web/src/features/chat）搬到手机上。
//
// 复用的是桌面的事实来源，一份也不重抄：
//   - model/message-annotations.js：选中抓取（含 UTF-16 偏移、prefix/suffix 上下文、emoji 半个
//     代理对的处理）、定位、校验、编号、草稿的归属；
//   - shared/ui/agent-elements/Quote.jsx 与它的 quote.css：引用块本体（图标、两行截断、编号、
//     评论行），也就是用户说的「注释样式跟客户端保持一致」；
//   - components/message-annotations.css：草稿行 / 编辑器 / 高亮 / notice 那一整份样式；
//   - conversation-search.js 的 scrollToConversationMatch：引用跳转。
//
// 手机端自己只有两件事：
//   1) 入口。iOS 原生选区菜单由 HaishWebView 通过公开的 UIResponder/UIMenuController 接口加入
//      Add Comment；点它时原生只发一个事件，选区抓取、偏移校验和草稿仍由桌面模型负责。浏览器/PWA
//      没有这条原生命令，保留一个轻量的自绘 Add Comment 入口。
//   2) 编辑器。选中后先进入与桌面一致的「引用预览 + 可选评论」，保存后才把草稿放进输入区；不再把
//      “Add to chat”误当作系统选区菜单动作。
import React from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  inline,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import { isNativeApp } from './native-connection.js';
import { addNativeCommentListener, reportNativeAnnotationSelection } from './native-comment-menu.js';
import { QuoteBlock, SelectionToolbar } from '../../haish-agent/app-web/src/shared/ui/agent-elements/Quote.jsx';
import {
  annotationError,
  annotationRange,
  annotationText,
  findAnnotationRange,
  captureAnnotationSelection,
} from '../../haish-agent/app-web/src/features/chat/model/message-annotations.js';
import { scrollToConversationMatch } from '../../haish-agent/app-web/src/features/chat/model/conversation-search.js';
import '../../haish-agent/app-web/src/features/chat/components/message-annotations.css';

// WKWebView 里 `crypto.randomUUID` 要安全上下文（且 iOS 15.4 起才有），而桌面的
// captureAnnotationSelection 直接调它。缺了就在这一处补上：批注的 id 只要在会话内唯一，
// 用不到密码学强度（runtime 只拿它去重与编号）；有 getRandomValues 就照样发一个真的 v4。
if (typeof globalThis.crypto?.randomUUID !== 'function' && globalThis.crypto) {
  const randomUuid = () => {
    const bytes = globalThis.crypto.getRandomValues?.(new Uint8Array(16));
    if (!bytes) return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  // crypto 是只读/不可扩展对象时只能作罢：那种环境下 capture 自己会报错，一个假 id 也救不了。
  try { Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUuid, configurable: true }); } catch { /* 见上 */ }
}

export const MessageAnnotations = React.forwardRef(function MessageAnnotations(
  { listRef, highlightItems = [], drafts, onSave, onError },
  ref,
) {
  const [selection, setSelection] = React.useState(null);
  const [editor, setEditor] = React.useState(null);
  const [comment, setComment] = React.useState('');
  const inputRef = React.useRef(null);
  const frameRef = React.useRef(0);
  const selectionRef = React.useRef(null);
  const close = React.useCallback(() => {
    selectionRef.current = null;
    window.getSelection()?.removeAllRanges();
    if (isNativeApp) reportNativeAnnotationSelection(false);
    setEditor(null);
    setSelection(null);
    setComment('');
  }, []);
  const { refs, floatingStyles, context } = useFloating({
    open: Boolean(selection || editor),
    onOpenChange: (open) => { if (!open) close(); },
    // 默认排在选区**下方**：iOS 的系统选择菜单默认在选区上方，错开一边才不会互相盖住。
    placement: 'bottom',
    middleware: [inline(), offset(8), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getFloatingProps } = useInteractions([dismiss]);

  const anchorTo = React.useCallback((range) => {
    if (!range) return;
    refs.setPositionReference({
      getBoundingClientRect: () => range.getBoundingClientRect(),
      getClientRects: () => range.getClientRects(),
      contextElement: range.startContainer.parentElement || undefined,
    });
  }, [refs]);

  const begin = React.useCallback(() => {
    // UIKit 点菜单项时选区有可能已经进入收起阶段，因此优先用最后一次有效抓取；如果 selectionchange
    // 还没来得及跑，就现场抓一次。原文/偏移仍由桌面模型生成，原生层不复制这套规则。
    const captured = selectionRef.current || captureAnnotationSelection(listRef.current);
    const item = captured?.annotation;
    if (!item) return;
    const error = annotationError([...drafts, item]);
    if (error) { onError(error); close(); return; }
    onError('');
    if (captured.range) anchorTo(captured.range);
    selectionRef.current = captured;
    setSelection(null);
    setEditor(item);
    setComment('');
  }, [anchorTo, close, drafts, listRef, onError]);

  React.useEffect(() => {
    if (!isNativeApp) return undefined;
    return addNativeCommentListener(begin);
  }, [begin]);

  const jump = React.useCallback((item) => {
    const range = findAnnotationRange(listRef.current, item);
    if (!range) { onError('The quoted text could not be located in this conversation.'); return; }
    onError('');
    scrollToConversationMatch(listRef.current, range);
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('annotation-focus', new Highlight(range));
  }, [listRef, onError]);

  const edit = React.useCallback((item) => {
    const range = findAnnotationRange(listRef.current, item);
    if (range) { scrollToConversationMatch(listRef.current, range); anchorTo(range); }
    else refs.setPositionReference(document.activeElement);
    setSelection(null);
    setEditor(item);
    setComment(item.comment || '');
  }, [anchorTo, listRef, refs]);

  React.useImperativeHandle(ref, () => ({ jump, edit }), [edit, jump]);

  // 选中就抓：iOS 上长按与拖手柄都只发 selectionchange（没有 mouseup），桌面上用的
  // mouseup / keyup 在浏览器里补一份，两边同一个抓法。
  React.useEffect(() => {
    if (editor) return undefined;
    const capture = () => {
      // WebKit emits selectionchange for every marked-text and caret update. Exit before scheduling
      // annotation work: only selections inside the message scroller can become annotations. The
      // bridge reporter deduplicates the single false edge, so later IME events stay local.
      const active = document.activeElement;
      const isEditableSelection = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active?.isContentEditable;
      if (isEditableSelection) {
        selectionRef.current = null;
        if (isNativeApp) reportNativeAnnotationSelection(false);
        else setSelection(null);
        return;
      }
      if (frameRef.current) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0;
        if (refs.floating.current?.contains(document.activeElement)) return;
        const captured = captureAnnotationSelection(listRef.current);
        const domSelection = window.getSelection();
        const hasDocumentSelection = Boolean(domSelection?.rangeCount && !domSelection.isCollapsed);
        if (captured) {
          selectionRef.current = captured;
          anchorTo(captured.range);
        } else if (hasDocumentSelection || isEditableSelection) {
          // A real selection somewhere else supersedes the last annotatable one. Do not clear only
          // because UIKit temporarily collapsed the DOM range while handing off its menu command.
          selectionRef.current = null;
        }
        // iOS 的入口属于系统菜单，不再画第二块浮层；同时把“这是不是可批注选区”报给
        // HaishWebView。UIKit 收起 DOM range 的瞬间继续保留最后一次有效抓取，避免用户点菜单项
        // 时 Add Comment 先一步消失；输入框或无关页面出现真实选区时则立即禁用。
        const nativeSelectionAvailable = Boolean(captured || (!hasDocumentSelection && selectionRef.current));
        if (isNativeApp) reportNativeAnnotationSelection(nativeSelectionAvailable);
        setSelection(isNativeApp ? null : captured);
      });
    };
    document.addEventListener('selectionchange', capture);
    document.addEventListener('mouseup', capture);
    document.addEventListener('touchend', capture);
    return () => {
      document.removeEventListener('selectionchange', capture);
      document.removeEventListener('mouseup', capture);
      document.removeEventListener('touchend', capture);
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      if (isNativeApp) reportNativeAnnotationSelection(false);
    };
  }, [editor, listRef, refs, anchorTo]);

  // 列表一滚，锚（选区矩形）就跑了：收起菜单，别让它挂在别处。
  React.useEffect(() => {
    const container = listRef.current;
    if (!container) return undefined;
    const hide = () => {
      selectionRef.current = null;
      setSelection(null);
      if (isNativeApp) reportNativeAnnotationSelection(false);
    };
    container.addEventListener('scroll', hide, { passive: true });
    return () => container.removeEventListener('scroll', hide);
  }, [listRef]);

  React.useEffect(() => {
    if (!selection && !editor) return undefined;
    const escape = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    // 收掉批注不该顺手触发会话的全局 Stop（桌面同款处理）。
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [selection, editor, close]);

  // 高亮：用的就是桌面那两个 highlight 伪元素（message-annotations.css 里的
  // `::highlight(message-annotations)`），所以颜色与桌面上看到的一模一样。
  //
  // 桌面还在答案右侧的空白里画编号药丸（.haish-annotation-marker）：那条留给 680px 的气泡，
  // 手机上气泡是满宽的，药丸会压在正文上，所以不画；号码由输入框里的草稿块、发出去的那条
  // 引用块承担（会话内同一个号，与桌面同一份编号）。
  React.useEffect(() => {
    const container = listRef.current;
    if (!container) return undefined;
    let frame = 0;
    const paint = () => {
      if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
      const sources = new Map();
      for (const node of container.querySelectorAll('[data-annotation-source]')) sources.set(node.dataset.annotationSource, node);
      const ranges = [];
      for (const entry of highlightItems) {
        const source = sources.get(entry.item.source_message_id);
        if (!source) continue;
        const range = annotationRange(annotationText(source), entry.item);
        if (range) ranges.push(range);
      }
      CSS.highlights.set('message-annotations', new Highlight(...ranges));
    };
    // 引用变了就**立即**重画（背景标签页里动画帧是停的，等帧就等于高亮一直不回来）；
    // 只有 Markdown 重排那类观察者触发的重算才按帧节流（一次重排就是一大串改动）。
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    paint();
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', paint);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', paint);
      if (frame) window.cancelAnimationFrame(frame);
      globalThis.CSS?.highlights?.delete('message-annotations');
      globalThis.CSS?.highlights?.delete('annotation-focus');
    };
  }, [highlightItems, listRef]);

  const save = () => {
    const item = { ...editor, comment: comment.trim() };
    if (onSave(item) === false) return;
    window.getSelection()?.removeAllRanges();
    selectionRef.current = null;
    close();
  };

  const floating = (selection || editor) ? (
    <FloatingFocusManager context={context} modal={false} disabled={!editor} initialFocus={inputRef} returnFocus>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={editor ? 'haish-annotation-floating' : 'annotation-menu'}
        {...getFloatingProps()}
        role={editor ? 'dialog' : 'toolbar'}
        aria-label={editor ? 'Comment on selected text' : 'Selected text'}
      >
        {editor ? (
          <div className="haish-annotation-editor">
            <QuoteBlock item={{ ...editor, comment: '' }} preview />
            <textarea
              ref={inputRef}
              value={comment}
              maxLength={2000}
              rows={2}
              placeholder="Add an optional comment…"
              aria-label="Optional comment"
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                // Enter 就是主按钮；Shift+Enter 留默认换行（桌面同款）。
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
              }}
            />
            <div className="haish-annotation-editor-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" onClick={save}>{drafts.some((item) => item.id === editor.id) ? 'Save comment' : 'Add to chat'}</button>
            </div>
          </div>
        ) : <SelectionToolbar onComment={begin} />}
      </div>
    </FloatingFocusManager>
  ) : null;

  // Native renders inside composer-dock so the existing keyboard controller moves editor and input
  // together. Browser/PWA keeps the body portal because it has no native keyboard surface.
  return isNativeApp ? floating : <FloatingPortal>{floating}</FloatingPortal>;
});
