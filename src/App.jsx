import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Folder,
  ImagePlus,
  Laptop,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  ShieldCheck,
  Smartphone,
  Square,
  SquarePen,
  X,
} from 'lucide-react';
import { api, runtimeConnectionState } from './api.js';
import { conversationHasSentMessage } from './agent-binding.js';
import {
  CHAT_IMAGE_MAX_COUNT,
  chatMessageText,
  chatImageValidationError,
  userMessageOccurrenceCount,
} from './chat-images.js';
import {
  hasNativePhotoPicker,
  isPhotoPickerCancellation,
  pickImagesFromLibrary,
  remainingImageSlots,
} from './photo-picker.js';
import { fitComposerTextarea } from './composer-height.js';
import { hideKeyboardAccessoryBar, isKeyboardMoving, mountKeyboardInset, registerKeyboardSurface } from './ios-keyboard.js';
import penguinLogo from './assets/penguin_logo_user.png';
import { ScrollToBottomButton } from './ScrollToBottomButton.jsx';
// 会话线程直接用桌面的行与时间线（见 chat-view.jsx / chat-runtime.js）。
import { ChatThread, releaseConversationImageUrls } from './chat-view.jsx';
// 线程末尾那个审批 / 提问插槽：卡片是桌面的，作用域是手机的（见 approval-slot.jsx）。
import { ChatApprovalSlot } from './approval-slot.jsx';
// 引用批注（桌面的「添加注释」，手机端叫「Add to chat」）：模型、草稿 hook、引用块与
// 选区菜单都在 message-annotations.jsx 里，这里只接线。
import { MessageAnnotations } from './message-annotations.jsx';
import { QuoteBlock } from '../../haish-agent/app-web/src/shared/ui/agent-elements/Quote.jsx';
import { useAnnotationDraft } from '../../haish-agent/app-web/src/features/chat/hooks/useAnnotationDraft.js';
import {
  annotationError,
  createAnnotationMessageSelector,
  isSubmittedAnnotationMessage,
  numberAnnotations,
  visibleAnnotationDrafts,
} from '../../haish-agent/app-web/src/features/chat/model/message-annotations.js';
// `window.haish` 的接缝：审批快照 → 桌面那套 store，下决定 → 适配器的三个端点（见 haish-bridge.js）。
import { publishApprovalState, waitingRequestConversation } from './haish-bridge.js';
import {
  buildChatRows,
  draftRuntimeTask,
  runtimeTaskWithEvent,
} from './chat-runtime.js';
import {
  SWIPE_BACK_CANCEL_EASING,
  SWIPE_BACK_EDGE_PX,
  SWIPE_BACK_TRACK_MS,
  isSwipeBackInFlight,
  setSwipeBackInFlight,
  swipeBackAxis,
  swipeBackOffset,
  swipeBackProgress,
  swipeBackRelease,
  swipeBackVelocity,
} from './swipe-back.js';
import {
  PULL_REFRESH_EASING,
  PULL_REFRESH_HOLD_MS,
  PULL_REFRESH_HOLD_PX,
  PULL_REFRESH_MIN_SPIN_MS,
  PULL_REFRESH_SETTLE_MS,
  isPullRefreshInFlight,
  pullRefreshArmed,
  pullRefreshAxis,
  pullRefreshDistance,
  pullRefreshProgress,
  setPullRefreshInFlight,
} from './pull-to-refresh.js';
import {
  THINKING_OPTIONS,
  agentOptionsFromPayload,
  providerOptionsFromSettings,
  resolveRunConfig,
  taskOptionsForRunConfig,
  withCurrentModel,
} from './run-config.js';
import { isCurrentTaskRunning, isFailureStatus } from './task-stream.js';
import { createTaskRuntimeSync } from './task-sync.js';
import { conversationSignature, statusSignature } from './poll-signature.js';
// 会话名：桌面那套占位名 + 第一条消息的一句话摘要（判据与 API 都在 conversation-title.js）。
import { conversationTitleForMessage, isPlaceholderConversationTitle } from './conversation-title.js';
import {
  CONVERSATION_PREVIEW_LIMIT,
  orderConversations,
  orderProjects,
} from './conversation-order.js';
// 会话行右端那个状态坑位（在跑 / 在等人 / 跑完还没看过）与桌面侧栏同一份判据，图标也用桌面那一对
// （glyph 的描边样式两边共用）。
import {
  conversationStatusSlot,
  loadConversationSeenAt,
  markConversationSeen,
  saveConversationSeenAt,
  seedConversationSeenAt,
} from './conversation-status.js';
import { ApprovalGlyph, WaitingInputGlyph } from '../../haish-agent/app-web/src/features/conversations/components/ConversationIcons.jsx';
import { RUN_STATE_APPROVAL, RUN_STATE_WAITING_INPUT } from '../../haish-agent/app-web/src/features/conversations/model/conversation-run-state.js';
import {
  DEFAULT_PREVIEW,
  nextExtraVisible,
  previewRows,
  previewWhenHidden,
} from './list-preview.js';
import {
  orphanReplyAnchors,
  orphanTaskReplies,
} from './task-replies.js';
import { createDismissHandoff, DIRECTORY_HOLD_CLASS } from './dismiss-handoff.js';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
// "没有在等人的快照" / "没有看过记录" 共用空表，省得每次渲染都新建一份。
const EMPTY_LIST = [];
const LAST_CONVERSATION_STORAGE_KEY = 'haish.remote.lastConversation.v1';
// Pressing and holding the image button keeps the old system sheet (camera, files) reachable.
const PHOTO_LONG_PRESS_MS = 450;
// 状态与审批那一圈只有几百字节，5 秒一问还算便宜；目录（~185KB）和详情里那份会话（最大 1.7MB）是
// 几百毫秒网络 + 几十毫秒解析，15 秒一问（以前三样都是 5 秒）。手势与键盘动画期间整圈跳过。
const STATUS_POLL_MS = 5_000;
const DIRECTORY_POLL_MS = 15_000;
const CONVERSATION_POLL_MS = 15_000;
// One sync for the whole app session: a task that was already streamed keeps its
// cursor, so leaving and re-entering a conversation resumes with the missing
// events instead of replaying the whole log.
const taskRuntime = createTaskRuntimeSync();

function storedConversationId() {
  try {
    return window.localStorage?.getItem(LAST_CONVERSATION_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveStoredConversationId(id) {
  try {
    if (id) window.localStorage?.setItem(LAST_CONVERSATION_STORAGE_KEY, id);
    else window.localStorage?.removeItem(LAST_CONVERSATION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private WebViews; navigation still works.
  }
}

/**
 * 手上正有手势（滑退/下拉）或键盘动画时，后台那几件重活（会话轮询、任务快照、目录、秒表 tick）
 * 全部让路：一份会话的解析与整棵重渲染落进动画里就是一帧几十毫秒的卡顿。
 */
function threadBusy() {
  return isSwipeBackInFlight() || isPullRefreshInFlight() || isKeyboardMoving();
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function textContent(content) {
  return chatMessageText(content);
}

function shortPath(value) {
  return value?.split('/').filter(Boolean).slice(-2).join('/') || '';
}

function PairingScreen({ runtimeOnline, onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.pair(code);
      await onPaired();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setError('');
    try {
      const pairing = await api.scanPairingCode();
      await api.pair(pairing.code, pairing.endpoint);
      await onPaired();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`pairing-shell ${api.isNative ? 'native' : ''}`}>
      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-brand">
          <img className="brand-mark" src={penguinLogo} alt="" draggable="false" />
          <span>Haish Agent</span>
        </div>
        <div className="pairing-intro">
          <h1 id="pairing-title">Connect to Haish</h1>
          <p>{api.isNative
            ? 'Pair this device with the Haish app running on your computer.'
            : 'Pair this desktop client with a computer running Haish Runtime.'}</p>
        </div>
        {api.isNative ? <div className="pairing-visual" aria-hidden="true">
          <div className="pairing-laptop"><span className="pairing-window"><i /><i /><i /><ScanLine size={54} /></span><b /></div>
          <div className="pairing-phone"><span className="pairing-scan-frame"><ScanLine size={40} /></span><em /></div>
        </div> : <div
          className={`pairing-visual pairing-remote-visual ${runtimeOnline ? 'online' : ''}`}
          role="img"
          aria-label={runtimeOnline ? 'Haish Runtime is ready to pair with a remote client' : 'Waiting for Haish Runtime'}
        >
          <div className="pairing-endpoint pairing-runtime-endpoint">
            <span className="pairing-endpoint-icon"><Laptop size={25} /></span>
            <span><strong>Haish computer</strong><small>{runtimeOnline ? 'Runtime ready' : 'Runtime offline'}</small></span>
            <i />
          </div>
          <div className="pairing-link-rail"><span><Link2 size={20} /></span></div>
          <div className="pairing-endpoint pairing-client-endpoint">
            <span className="pairing-client-window"><i /><i /><i /></span>
            <span><strong>Remote client</strong><small>Enter pairing code</small></span>
          </div>
        </div>}
        {api.isNative ? <>
          <div className="pairing-guide">
            <div className="pairing-guide-title"><span />How to connect<span /></div>
            <div className="pairing-step"><strong>1</strong><span>Open Remote Control in Haish<br />on your computer.</span></div>
            <div className="pairing-step"><strong>2</strong><span>Scan the QR code with this device.</span></div>
            <div className="pairing-step"><strong>3</strong><span>Wait for the connection to complete.</span></div>
          </div>

          {error ? <p className="form-error pairing-error" role="alert"><CircleAlert size={18} />{error}</p> : null}
          <button type="button" className="primary-button pairing-scan-button" disabled={busy} onClick={scan}>
            {busy ? <LoaderCircle className="spin" size={20} /> : <ScanLine size={20} />}
            {busy ? 'Opening camera…' : 'Scan pairing QR code'}
          </button>
          <p className="pairing-help">Open Remote Control in Haish on your computer, then scan its QR code.</p>
        </> : <div className="pairing-web">
          <div className="pairing-guide pairing-web-guide">
            <div className="pairing-guide-title"><span />How to connect<span /></div>
            <div className="pairing-step"><strong>1</strong><span>Run <code>npm run pair</code> on the Haish computer.</span></div>
            <div className="pairing-step"><strong>2</strong><span>Enter the 8-digit code in this remote client.</span></div>
            <div className="pairing-step"><strong>3</strong><span>Connect securely to finish pairing.</span></div>
          </div>
          <form className="pairing-form" onSubmit={submit}>
            <div className="field-heading"><label htmlFor="pair-code">Pairing code</label><span>8 digits</span></div>
            <input
              id="pair-code"
              className="pair-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={9}
              value={code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="0000 0000"
              required
            />
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="primary-button" disabled={busy || code.length !== 8}>
              {busy ? <LoaderCircle className="spin" size={20} /> : <ArrowRight size={20} />}
              {busy ? 'Connecting…' : 'Connect securely'}
            </button>
          </form>
        </div>}
        <p className="security-note"><ShieldCheck size={14} /> Only paired clients can access this Haish Runtime.</p>
      </section>
    </main>
  );
}

function ConnectionScreen({ error, retrying, onRetry }) {
  const failed = Boolean(error);
  return (
    <main className={`connection-screen ${failed ? 'failed' : ''}`}>
      <div className="connection-brand">
        <img src={penguinLogo} alt="" draggable="false" />
        <span>Haish Agent</span>
      </div>
      <section className="connection-panel" aria-live="polite" aria-busy={!failed || retrying}>
        <div className="connection-visual" aria-hidden="true">
          <span className="connection-device"><Laptop size={30} /></span>
          <span className="connection-route"><i /><b>{failed ? <CircleAlert size={18} /> : <Link2 size={18} />}</b><i /></span>
          <span className="connection-device phone"><Smartphone size={30} /></span>
        </div>
        <div className="connection-state-label">
          <span />{failed ? (retrying ? 'Retrying' : 'Connection paused') : 'Secure connection'}
        </div>
        <h1>{failed ? 'Can’t reach your Mac' : 'Connecting to Haish'}</h1>
        <p>{failed
          ? 'Keep Haish open on your computer and check that this device has internet access.'
          : 'Waking your remote workspace and syncing your tasks.'}</p>
        {failed ? <button type="button" className="connection-retry" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={retrying ? 'spin' : ''} size={19} aria-hidden="true" />
          {retrying ? 'Trying again…' : 'Try again'}
        </button> : <div className="connection-progress" role="status"><span /><span /><span /></div>}
      </section>
      <p className="connection-security"><ShieldCheck size={15} aria-hidden="true" /> End-to-end access to your paired computer</p>
    </main>
  );
}

// 一行只有一个状态坑位（判据见 conversation-status.js）：在等人 / 在跑 / 跑完还没看过，同一时刻只亮一个。
// 两种「等用户动手」的灯与桌面侧栏同一对 glyph；颜色由 .conversation-running-indicator.waiting-input /
// .awaiting-approval 给（见 styles.css，桌面那份写在 panels.css 里）。
const WAIT_INDICATORS = {
  [RUN_STATE_WAITING_INPUT]: {
    className: 'waiting-input',
    label: 'Waiting for your answer',
    Glyph: WaitingInputGlyph,
  },
  [RUN_STATE_APPROVAL]: {
    className: 'awaiting-approval',
    label: 'Awaiting approval',
    Glyph: ApprovalGlyph,
  },
};

function ConversationRow({ conversation, slot, onOpen }) {
  const wait = slot ? WAIT_INDICATORS[slot.kind] : null;
  const WaitGlyph = wait?.Glyph;
  return (
    <button className="conversation-row" onClick={() => onOpen(conversation)}>
      <span className="conversation-title">{conversation.title || conversation.label}</span>
      {wait ? <span className={`conversation-running-indicator ${wait.className}`} role="status" aria-label={wait.label}><WaitGlyph /></span>
        : slot?.kind === 'running' ? <LoaderCircle className="spin conversation-running" size={17} aria-label="Running" />
          : slot?.kind === 'terminal' ? <span className={`conversation-terminal-notice chat-timeline-status status-${slot.status}`} aria-hidden="true" />
            : null}
    </button>
  );
}

// "Show more" is view state, not user data: it lives with the section that owns
// the list, and folding that section away drops the expansion so reopening it
// shows the default three rows again — the desktop panel resets the same way.
function useConversationPreview(listVisible) {
  const [extraVisible, setExtraVisible] = useState(DEFAULT_PREVIEW);
  useEffect(() => {
    setExtraVisible((previous) => previewWhenHidden(previous, listVisible));
  }, [listVisible]);
  return [extraVisible, setExtraVisible];
}

// The list every section shares: ordered like the desktop sidebar, three rows by
// default, "Show more" adds three at a time, and once the last row is visible the
// button turns into "Show less". While a search is running every match stays
// visible — the cap is a browsing default, not a filter.
function ConversationPreviewList({ conversations, tasks, statusInputs, extraVisible, onExtraVisibleChange, onOpen, previewLimit = CONVERSATION_PREVIEW_LIMIT }) {
  const ordered = orderConversations(conversations, tasks);
  const { visible, hiddenCount, showToggle } = previewRows(ordered, extraVisible, previewLimit);
  return <>
    {visible.map((conversation) => <ConversationRow
      key={conversation.conversation_id}
      conversation={conversation}
      slot={conversationStatusSlot({ conversation, tasksById: tasks, ...statusInputs })}
      onOpen={onOpen}
    />)}
    {showToggle ? <button
      type="button"
      className="conversation-show-more"
      onClick={() => onExtraVisibleChange((current) => nextExtraVisible(current, hiddenCount))}
    >{hiddenCount > 0 ? 'Show more' : 'Show less'}</button> : null}
  </>;
}

function ProjectGroup({ project, tasks, statusInputs, onOpen, onNew, previewLimit }) {
  const [open, setOpen] = useState(true);
  const [extraVisible, setExtraVisible] = useConversationPreview(open);
  const conversations = project.conversations || [];
  return (
    <section className="project-group">
      <div className="project-heading">
        <div className="project-title">
          <button className={`project-icon-toggle ${open ? 'open' : ''}`} type="button" onClick={() => setOpen((value) => !value)} aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open}>
            <span className="project-icon" aria-hidden="true" />
          </button>
          <span className="project-copy">
            <strong>{project.name}</strong>
            {project.workspace_path ? <small>{shortPath(project.workspace_path)}</small> : null}
          </span>
        </div>
        <button className="row-action" onClick={() => onNew(project.project_id)} aria-label={`Create a task in ${project.name}`}><SquarePen size={20} /></button>
      </div>
      {open ? <div className="conversation-list">
        <ConversationPreviewList conversations={conversations} tasks={tasks} statusInputs={statusInputs} extraVisible={extraVisible} onExtraVisibleChange={setExtraVisible} onOpen={onOpen} previewLimit={previewLimit} />
        {!conversations.length ? <p className="project-empty">No conversations yet</p> : null}
      </div> : null}
    </section>
  );
}

function PinnedGroup({ conversations, tasks, statusInputs, onOpen, previewLimit }) {
  const [open, setOpen] = useState(true);
  const [extraVisible, setExtraVisible] = useConversationPreview(open);
  return (
    <section className="pinned-group">
      <button className="section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><Pin size={15} />Pinned<span>{conversations.length}</span><ChevronDown className="disclosure" size={16} /></button>
      {open ? <div className="pinned-list">
        <ConversationPreviewList conversations={conversations} tasks={tasks} statusInputs={statusInputs} extraVisible={extraVisible} onExtraVisibleChange={setExtraVisible} onOpen={onOpen} previewLimit={previewLimit} />
      </div> : null}
    </section>
  );
}

function ProjectPicker({ projects, onChoose, onClose }) {
  return (
    <div className="sheet-scrim" role="presentation" onClick={onClose}>
      <section className="project-sheet" role="dialog" aria-modal="true" aria-labelledby="project-picker-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title"><h2 id="project-picker-title">Choose a project</h2><button className="icon-button ghost" onClick={onClose} aria-label="Close"><X size={21} /></button></div>
        <div className="project-options">
          {projects.map((project) => (
            <button key={project.project_id} onClick={() => onChoose(project.project_id)}><span className="project-option-icon" aria-hidden="true" /><span><strong>{project.name}</strong><small>{shortPath(project.workspace_path) || 'Default project'}</small></span></button>
          ))}
        </div>
      </section>
    </div>
  );
}

function RunConfigSheet({ config, agentLabel, agentLocked, agents, providers, models, modelLoading, onChange, onClose }) {
  const [activeField, setActiveField] = useState(null);

  function changeProvider(providerId) {
    const provider = providers.find((item) => item.id === providerId);
    onChange((current) => ({
      ...current,
      providerId,
      modelId: provider?.defaultModelId || provider?.models[0]?.id || '',
      thinking: THINKING_OPTIONS.some((item) => item.id === provider?.reasoningEffort)
        ? provider.reasoningEffort
        : current.thinking,
    }));
  }

  const fields = [
    // agent 只在会话还没发过消息时能换：runtime 在首个被接受的 chat turn 上写死绑定，之后
    // 再换一定 400。锁着的时候显示服务端记着的那个 agent（见 agent-binding.js）。
    { id: 'agent', label: 'Agent', value: config.agentId, displayValue: agentLabel, options: agents, locked: agentLocked, change: (value) => onChange((current) => ({ ...current, agentId: value })) },
    { id: 'provider', label: 'Provider', value: config.providerId, options: providers, change: changeProvider },
    { id: 'model', label: 'Model', value: config.modelId, options: models, change: (value) => onChange((current) => ({ ...current, modelId: value })), disabled: modelLoading || !models.length },
    { id: 'thinking', label: 'Thinking', value: config.thinking, options: THINKING_OPTIONS, change: (value) => onChange((current) => ({ ...current, thinking: value })) },
  ];

  return (
    <div className="sheet-scrim" role="presentation" onClick={onClose}>
      <section className="run-config-sheet" role="dialog" aria-modal="true" aria-labelledby="run-config-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="run-config-heading"><h2 id="run-config-title">Run configuration</h2><p>Applies to the next task in this conversation.</p></div>
        <div className="run-config-fields">
          {fields.map((field) => {
            const open = activeField === field.id;
            const selected = field.options.find((item) => item.id === field.value);
            return <div className={`run-config-field-group ${open ? 'open' : ''}`} key={field.id}>
              {field.locked ? <div className="run-config-field locked" aria-label={`${field.label} ${field.displayValue || selected?.label || field.value}, fixed for this conversation`}>
                <span>{field.label}</span>
                <strong>{field.displayValue || selected?.label || field.value || 'Unavailable'}</strong>
                <LockKeyhole size={17} aria-hidden="true" />
              </div> : <button
                type="button"
                className="run-config-field"
                disabled={field.disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setActiveField(open ? null : field.id)}
              >
                <span>{field.label}</span>
                <strong>{field.disabled ? 'Loading…' : selected?.label || 'Unavailable'}</strong>
                <ChevronDown size={18} aria-hidden="true" />
              </button>}
              {open ? <div className="run-config-options" role="listbox" aria-label={field.label}>
                {field.options.map((item) => <button
                  type="button"
                  role="option"
                  aria-selected={item.id === field.value}
                  className={item.id === field.value ? 'selected' : ''}
                  key={item.id}
                  onClick={() => { field.change(item.id); setActiveField(null); }}
                >
                  <span>{item.label}</span>
                  {item.id === field.value ? <Check size={18} aria-hidden="true" /> : null}
                </button>)}
              </div> : null}
            </div>;
          })}
        </div>
      </section>
    </div>
  );
}

// Pull-to-refresh: the platform's refresh control, built the way this app builds gestures
// (see swipe-back.js). The component owns the touch listeners, the surface travels under
// the finger through one style write per frame, and the refresh only starts once the pull
// passed the trigger distance. `listenRef` is the element that receives the touch,
// `surfaceRef` the one that travels, and the indicator is pinned above the surface's first
// pixel so the pull reveals it from under the header, the way a native control slides out.
function usePullToRefresh({ listenRef, surfaceRef, indicatorRef, canStart, onRefresh }) {
  const onRefreshRef = useRef(onRefresh);
  const canStartRef = useRef(canStart);
  useEffect(() => { onRefreshRef.current = onRefresh; });
  useEffect(() => { canStartRef.current = canStart; });

  useEffect(() => {
    const listen = listenRef.current;
    const surface = surfaceRef.current;
    const indicator = indicatorRef.current;
    if (!listen || !surface || !indicator) return undefined;
    const icon = indicator.querySelector('svg') || indicator;
    let alive = true;
    let start = null;
    let claimed = false;
    let busy = false;
    let distance = 0;
    let frame = 0;
    let pending = null;
    let motion = null;
    let motionTimer = 0;

    function stopMotion() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      if (motion) motion.cancel();
      motion = null;
      if (motionTimer) window.clearTimeout(motionTimer);
      motionTimer = 0;
    }

    function paint(next) {
      distance = next;
      surface.style.transform = `translate3d(0, ${next}px, 0)`;
      const progress = pullRefreshProgress(next);
      indicator.style.opacity = String(progress);
      icon.style.transform = `rotate(${Math.round(progress * 180)}deg)`;
    }

    // Hands the surface back to CSS once the motion has landed. `pull-active` deliberately
    // stays on until then: dropping the promoted layer mid-flight rebuilds it, which reads
    // as a hitch in the same way it did in the back swipe.
    function rest() {
      stopMotion();
      surface.classList.remove('pull-active');
      surface.style.transform = '';
      indicator.style.opacity = '';
      indicator.classList.remove('spinning');
      icon.style.transform = '';
      distance = 0;
      start = null;
      claimed = false;
      busy = false;
      setPullRefreshInFlight(false);
    }

    // The refresh is in flight: the surface waits at the hold distance and the spinner
    // turns, whatever the finger was doing when it let go.
    function hold() {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const from = distance;
      stopMotion();
      distance = PULL_REFRESH_HOLD_PX;
      surface.style.transform = `translate3d(0, ${PULL_REFRESH_HOLD_PX}px, 0)`;
      indicator.style.opacity = '1';
      icon.style.transform = '';
      if (reduced || from === PULL_REFRESH_HOLD_PX) return;
      const animation = surface.animate(
        [{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, ${PULL_REFRESH_HOLD_PX}px, 0)` }],
        { duration: PULL_REFRESH_HOLD_MS, easing: PULL_REFRESH_EASING, fill: 'both' },
      );
      motion = animation;
      animation.onfinish = () => {
        if (motion !== animation) return;
        animation.cancel();
        motion = null;
      };
    }

    function settleBack() {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const from = distance;
      stopMotion();
      distance = 0;
      surface.style.transform = 'translate3d(0, 0px, 0)';
      indicator.style.opacity = '0';
      icon.style.transform = 'rotate(0deg)';
      if (reduced || !(from > 0)) {
        rest();
        return;
      }
      const animation = surface.animate(
        [{ transform: `translate3d(0, ${from}px, 0)` }, { transform: 'translate3d(0, 0px, 0)' }],
        { duration: PULL_REFRESH_SETTLE_MS, easing: PULL_REFRESH_EASING, fill: 'both' },
      );
      motion = animation;
      const landed = () => {
        if (motion !== animation) return;
        animation.cancel();
        motion = null;
        rest();
      };
      animation.onfinish = landed;
      motionTimer = window.setTimeout(landed, PULL_REFRESH_SETTLE_MS + 80);
    }

    async function startRefresh() {
      busy = true;
      hold();
      indicator.classList.add('spinning');
      const startedAt = Date.now();
      try {
        await onRefreshRef.current?.();
      } catch {
        // The screen's own error path reports what failed; the surface only settles back.
      }
      const remaining = PULL_REFRESH_MIN_SPIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => { window.setTimeout(resolve, remaining); });
      if (!alive || !busy) return;
      settleBack();
    }

    function begin(event) {
      if (busy) return;
      const touch = event.touches?.[0];
      if (!touch || event.touches.length !== 1) return;
      if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (!canStartRef.current?.()) return;
      stopMotion();
      start = { x: touch.clientX, y: touch.clientY };
      claimed = false;
      paint(0);
    }

    function flush() {
      frame = 0;
      const point = pending;
      pending = null;
      if (!point || !start) return;
      paint(pullRefreshDistance(point.y - start.y));
    }

    function move(event) {
      const touch = event.touches?.[0];
      if (!start || !touch) return;
      if (!claimed) {
        const axis = pullRefreshAxis(touch.clientX - start.x, touch.clientY - start.y);
        if (!axis) return;
        if (axis !== 'pull') { start = null; return; }
        claimed = true;
        setPullRefreshInFlight(true);
        surface.classList.add('pull-active');
        // Own the touch from the frame that claims it, so the WebView neither starts a
        // scroll of its own nor holds the touch stream back until that scroll settles.
        if (event.cancelable) event.preventDefault();
        paint(pullRefreshDistance(touch.clientY - start.y));
        return;
      }
      if (event.cancelable) event.preventDefault();
      // Touch moves can arrive faster than the display refreshes; take one sample per frame.
      pending = { y: touch.clientY };
      if (!frame) frame = window.requestAnimationFrame(flush);
    }

    function end(event) {
      if (!start || !claimed) { start = null; return; }
      const touch = event.changedTouches?.[0];
      if (touch) paint(pullRefreshDistance(touch.clientY - start.y));
      start = null;
      claimed = false;
      // A pull that travelled is not a tap: no row and no message may react to it.
      if (event.cancelable) event.preventDefault();
      if (pullRefreshArmed(distance)) startRefresh();
      else settleBack();
    }

    function cancel(event) {
      if (!start || !claimed) { start = null; return; }
      start = null;
      claimed = false;
      if (event.cancelable) event.preventDefault();
      settleBack();
    }

    listen.addEventListener('touchstart', begin, { passive: true });
    listen.addEventListener('touchmove', move, { passive: false });
    listen.addEventListener('touchend', end, { passive: false });
    listen.addEventListener('touchcancel', cancel, { passive: false });
    return () => {
      alive = false;
      stopMotion();
      setPullRefreshInFlight(false);
      listen.removeEventListener('touchstart', begin);
      listen.removeEventListener('touchmove', move);
      listen.removeEventListener('touchend', end);
      listen.removeEventListener('touchcancel', cancel);
    };
  }, [indicatorRef, listenRef, surfaceRef]);
}

// 目录整棵树跟着 App 重渲染一次不便宜（每一行都要重算预览、分组、排序），而会话详情开着时它在下面完全
// 看不见。开、关会话都会重渲染整页，收尾那几帧正好撞上，所以给它套一层 memo。
const ConversationList = React.memo(function ConversationList({ projects, conversations, tasks, status, approvals, loading, error, seenAt, onRefresh, onOpen, onNew, onSettings }) {
  const [query, setQuery] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const homeRef = useRef(null);
  const bodyRef = useRef(null);
  const refreshIndicatorRef = useRef(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const pinned = conversations.filter((conversation) => conversation.pinned && (!normalizedQuery || `${conversation.title} ${conversation.label}`.toLocaleLowerCase().includes(normalizedQuery)));
  const projectIds = new Set(projects.map((project) => project.project_id));
  const ungrouped = conversations.filter((conversation) => !conversation.pinned
    && (!conversation.project_id || !projectIds.has(conversation.project_id))
    && (!normalizedQuery || `${conversation.title} ${conversation.label}`.toLocaleLowerCase().includes(normalizedQuery)));
  const visibleProjects = projects.map((project) => {
    const projectMatches = `${project.name} ${project.workspace_path || ''}`.toLocaleLowerCase().includes(normalizedQuery);
    return {
      ...project,
      conversations: (project.conversations || []).filter((conversation) => !conversation.pinned && (projectMatches || !normalizedQuery || `${conversation.title} ${conversation.label}`.toLocaleLowerCase().includes(normalizedQuery))),
    };
  }).filter((project) => !normalizedQuery || project.conversations.length || `${project.name} ${project.workspace_path || ''}`.toLocaleLowerCase().includes(normalizedQuery));
  // Projects follow the desktop rule too: pinned first, then the stored order.
  const orderedProjects = orderProjects(visibleProjects);
  const previewLimit = normalizedQuery ? Number.POSITIVE_INFINITY : CONVERSATION_PREVIEW_LIMIT;

  // 项目（以及“Other conversations”）共用一份状态输入：行尾坑位读的就是这几个。
  const statusInputs = React.useMemo(() => ({
    seenAt,
    pendingInputs: approvals?.pending_user_inputs || EMPTY_LIST,
    pendingApprovals: approvals ? [
      ...(approvals.pending || []),
      ...(approvals.pending_workflow_approvals || []),
      ...(approvals.pending_browser_runtime_installs || []),
    ] : EMPTY_LIST,
  }), [seenAt, approvals]);

  function startNew() {
    if (projects.length <= 1) onNew(projects[0]?.project_id);
    else setShowProjectPicker(true);
  }

  // A directory that never loaded must not read as "no conversations yet": this is the one
  // state where the list has to explain itself and offer the way out it has left.
  const loadFailed = Boolean(error) && conversations.length === 0;
  usePullToRefresh({
    listenRef: homeRef,
    surfaceRef: bodyRef,
    indicatorRef: refreshIndicatorRef,
    canStart: () => window.scrollY <= 0,
    onRefresh,
  });

  return (
    <main className="remote-home" ref={homeRef}>
      <div className="remote-topbar">
        <header className="remote-header">
          <img className="header-brand" src={penguinLogo} alt="" draggable="false" />
          <div className="remote-title"><h1>Haish</h1><p className={status.runtime_online ? 'online' : ''}><span className="status-dot" /> <Laptop size={15} /> {status.computer_model || 'Computer'}</p></div>
          <button className="icon-button ghost" onClick={onSettings} aria-label="Setting"><MoreHorizontal size={26} /></button>
        </header>
        <label className="search-field"><Search size={23} aria-hidden="true" /><span className="sr-only">Search conversations</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /></label>
      </div>
      <div className="remote-body" ref={bodyRef}>
        <span className="pull-refresh" ref={refreshIndicatorRef} aria-hidden="true"><LoaderCircle size={21} /></span>
        {loading && conversations.length === 0 ? <div className="center-state"><LoaderCircle className="spin" /><span>Syncing…</span></div> : null}
        {!loading && conversations.length === 0 && loadFailed ? (
          <div className="load-failed tall"><CircleAlert size={28} aria-hidden="true" /><h2>Couldn’t load conversations</h2><p>Pull down to try again.</p></div>
        ) : null}
        {!loading && conversations.length === 0 && !loadFailed ? (
          <div className="empty-state"><Folder size={30} /><h2>No conversations yet</h2><p>Create a task and it will appear on your computer.</p></div>
        ) : null}
        <div className="directory-list">
          {pinned.length ? <PinnedGroup conversations={pinned} tasks={tasks} statusInputs={statusInputs} onOpen={onOpen} previewLimit={previewLimit} /> : null}
          {orderedProjects.map((project) => <ProjectGroup key={project.project_id} project={project} tasks={tasks} statusInputs={statusInputs} onOpen={onOpen} onNew={onNew} previewLimit={previewLimit} />)}
          {ungrouped.length ? <ProjectGroup project={{ project_id: '', name: 'Other conversations', conversations: ungrouped }} tasks={tasks} statusInputs={statusInputs} onOpen={onOpen} onNew={onNew} previewLimit={previewLimit} /> : null}
          {!loading && query && !pinned.length && !visibleProjects.length && !ungrouped.length ? <p className="no-results">No matching conversations</p> : null}
        </div>
      </div>
      <div className="new-task-dock"><button className="new-task-button" onClick={startNew}><span className="new-task-icon"><Plus size={20} /></span><span>New task</span></button></div>
      {showProjectPicker ? <ProjectPicker projects={projects} onChoose={(projectId) => { setShowProjectPicker(false); onNew(projectId); }} onClose={() => setShowProjectPicker(false)} /> : null}
    </main>
  );
});

function ImagePreview({ image, onClose }) {
  useEffect(() => {
    if (!image) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [image, onClose]);
  if (!image) return null;
  return (
    <div className="image-preview" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
      <button type="button" onClick={onClose} aria-label="Close image preview"><X size={24} /></button>
      <img src={image.src} alt={image.name || 'Attached image'} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}

// 审批插槽按会话收窄时的兜底作用域（请求自己带 conversation_id 就用不上它，见 approval-slot.jsx）。
function taskIdsOf(conversation) {
  return (conversation?.tasks || []).map((task) => task?.task_id).filter(Boolean);
}

function ConversationDetail({ id, projectName, initialConversation, onBack, connection }) {
  const [conversation, setConversation] = useState(initialConversation || null);
  const [conversationHydrated, setConversationHydrated] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [liveRun, setLiveRun] = useState(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState([]);
  const [composerImages, setComposerImages] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  // 每个任务的执行记录（桌面形状的 runtime task：eventLog + 记录字段），
  // 行/时间线由桌面组件渲染（见 chat-runtime.js）。
  const [taskRuntimes, setTaskRuntimes] = useState({});
  const [agents, setAgents] = useState([]);
  const [providers, setProviders] = useState([]);
  const [runConfig, setRunConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [runConfigExpanded, setRunConfigExpanded] = useState(false);
  const [showRunConfig, setShowRunConfig] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const messageScrollRef = useRef(null);
  const messageRegionRef = useRef(null);
  const messageBodyRef = useRef(null);
  const composerDockRef = useRef(null);
  const refreshIndicatorRef = useRef(null);
  const messageInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const photoLongPressRef = useRef(false);
  const photoLongPressTimerRef = useRef(0);
  const detailScreenRef = useRef(null);
  const swipeStartRef = useRef(null);
  const swipeOffsetRef = useRef(0);
  const swipeAnimationRef = useRef(null);
  const swipeSettleRef = useRef(null);
  const swipeFrameRef = useRef(0);
  const swipePendingRef = useRef(null);
  const deferredRefreshRef = useRef(false);
  const conversationSignatureRef = useRef('');
  const swipeBlockedRef = useRef(false);
  const dismissHandoffRef = useRef(null);
  // 收起那个动作会一直活着（`createDismissHandoff` 只在第一次收起时建一次），所以 `onBack` 得穿过一层
  // ref：否则它拿的永远是建它的那一次渲染的 `onBack`。这个文件里 `swipeHandlersRef` 也是这么做的。
  const onBackRef = useRef(onBack);
  const swipeHandlersRef = useRef(null);
  const composerImagesRef = useRef([]);
  const optimisticUserMessagesRef = useRef([]);
  const runConfigQuickRef = useRef(null);
  const localStreamRef = useRef(false);
  const liveRunRef = useRef(null);
  const liveRunFrameRef = useRef(0);
  const runConfigRef = useRef(null);
  const loadedTraceIdsRef = useRef(new Set());

  // 流式回答是一串很密的事件（每几个字一条）：一条一条 setState 就是每几个字把整页重渲染一次，
  // 真机上跑任务时整页都在抖。改成先折进 ref，每帧最多往 React 递一次；这一趟收尾由调用方
  // （`flushLiveRun`）落地，别把最后一帧留在动画里。
  const scheduleLiveRun = useCallback((nextRun) => {
    liveRunRef.current = nextRun;
    if (liveRunFrameRef.current) return;
    liveRunFrameRef.current = window.requestAnimationFrame(() => {
      liveRunFrameRef.current = 0;
      setLiveRun(liveRunRef.current);
    });
  }, []);

  const flushLiveRun = useCallback(() => {
    if (liveRunFrameRef.current) window.cancelAnimationFrame(liveRunFrameRef.current);
    liveRunFrameRef.current = 0;
    setLiveRun(liveRunRef.current);
  }, []);

  // 这个 ref 是流式的缓冲：动画帧还挂着的时候别用 state 把它盖回去（那一帧接着读的就是它）。
  useEffect(() => { if (!liveRunFrameRef.current) liveRunRef.current = liveRun; }, [liveRun]);
  useEffect(() => { runConfigRef.current = runConfig; }, [runConfig]);
  useEffect(() => { composerImagesRef.current = composerImages; }, [composerImages]);
  useEffect(() => { optimisticUserMessagesRef.current = optimisticUserMessages; }, [optimisticUserMessages]);
  useEffect(() => { swipeBlockedRef.current = Boolean(previewImage || showRunConfig); }, [previewImage, showRunConfig]);
  useEffect(() => { onBackRef.current = onBack; }, [onBack]);

  // 输入框高度跟着草稿走（见 composer-height.js）：展开态不再预留一行空白。打字这条走便宜路
  // （不写 `auto`、没变高就不写 CSS），只有草稿变短时才重量一次——每个按键都量一次就是每键一次
  // 强制布局，手机上的「打字不跟手」。
  useEffect(() => {
    fitComposerTextarea(messageInputRef.current);
  }, [message]);
  // 宽度变化（展开、旋转屏幕、右侧配置图标出现/收起）会改变折行，这些时候必须重量一次。
  useEffect(() => {
    fitComposerTextarea(messageInputRef.current, { force: true });
  }, [id, composerExpanded, runConfig, runConfigExpanded]);
  useEffect(() => {
    const fit = () => fitComposerTextarea(messageInputRef.current, { force: true });
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  function clearSwipeBackFrame() {
    if (swipeFrameRef.current) window.cancelAnimationFrame(swipeFrameRef.current);
    swipeFrameRef.current = 0;
    swipePendingRef.current = null;
  }

  // Hands the surface back to CSS and forgets the pull: used when the touch turns out to
  // belong to the thread, when it is cancelled, and when the screen unmounts.
  function stopSwipeBackMotion() {
    clearSwipeBackFrame();
    swipeAnimationRef.current?.cancel();
    swipeAnimationRef.current = null;
    swipeSettleRef.current?.cancel();
    swipeSettleRef.current = null;
    detailScreenRef.current?.classList.remove('swipe-armed', 'swipe-dismissing');
    swipeStartRef.current = null;
    swipeOffsetRef.current = 0;
    setSwipeBackInFlight(false);
  }

  function setSwipeBackProgress(progress) {
    const animation = swipeAnimationRef.current;
    if (!animation) return;
    animation.currentTime = Math.min(1, Math.max(0, progress)) * SWIPE_BACK_TRACK_MS;
  }

  // Whatever a gesture pushed aside (a poll that would have landed mid-motion, or a pull
  // that ends it) is fetched once the surface is back at rest.
  function flushDeferredRefresh() {
    if (!deferredRefreshRef.current) return;
    deferredRefreshRef.current = false;
    refresh();
  }

  function beginSwipeBack(event) {
    const surface = detailScreenRef.current;
    if (!surface || event.touches.length !== 1 || swipeBlockedRef.current) return;
    const touch = event.touches[0];
    if (touch.clientX > SWIPE_BACK_EDGE_PX) return;
    stopSwipeBackMotion();
    // Promote the surface before the finger moves, so the first tracked frame does not
    // have to build the layer too, and let the directory behind it keep animating.
    surface.classList.add('swipe-armed');
    swipeStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: event.timeStamp,
      lastX: touch.clientX,
      lastY: touch.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
      width: surface.getBoundingClientRect().width || window.innerWidth,
      claimed: false,
    };
  }

  // The pull runs on a Web Animations timeline instead of a CSS custom property: moving an
  // animation's time only reaches the compositor, while writing `--swipe-back-offset` on
  // every touch move recalculates style for the whole message list underneath.
  function claimSwipeBack() {
    const surface = detailScreenRef.current;
    if (!surface) return;
    const animation = surface.animate(
      [{ transform: 'translate3d(0%, 0px, 0px)' }, { transform: 'translate3d(100%, 0px, 0px)' }],
      { duration: SWIPE_BACK_TRACK_MS, easing: 'linear', fill: 'both' },
    );
    animation.pause();
    animation.currentTime = 0;
    swipeAnimationRef.current = animation;
    setSwipeBackInFlight(true);
  }

  function applySwipeBack(point) {
    const start = swipeStartRef.current;
    if (!start) return;
    start.velocity = swipeBackVelocity(start.velocity, {
      deltaX: point.x - start.lastX,
      deltaMs: point.time - start.lastTime,
    });
    start.lastX = point.x;
    start.lastY = point.y;
    start.lastTime = point.time;
    const offset = swipeBackOffset(start, { x: point.x, y: point.y });
    swipeOffsetRef.current = offset;
    setSwipeBackProgress(swipeBackProgress(offset, start.width));
  }

  function flushSwipeBack() {
    swipeFrameRef.current = 0;
    const point = swipePendingRef.current;
    swipePendingRef.current = null;
    if (!point || !swipeStartRef.current?.claimed) return;
    applySwipeBack(point);
  }

  function moveSwipeBack(event) {
    const start = swipeStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const point = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    if (!start.claimed) {
      const axis = swipeBackAxis(point.x - start.x, point.y - start.y);
      if (!axis) return;
      if (axis !== 'horizontal') {
        // A drag that leaves the cone belongs to the thread; let the scroll have it.
        stopSwipeBackMotion();
        return;
      }
      start.claimed = true;
      claimSwipeBack();
      // Non-passive listener: claiming the pull here is what stops the WebView from
      // scrolling the thread and holding the touch stream back until it settles. The pull
      // also follows the finger on the frame that claims it — waiting for the next one is
      // what reads as lag at the start.
      if (event.cancelable) event.preventDefault();
      applySwipeBack(point);
      return;
    }
    if (event.cancelable) event.preventDefault();
    // Touch moves can arrive faster than the display refreshes; take one sample per frame.
    swipePendingRef.current = point;
    if (!swipeFrameRef.current) swipeFrameRef.current = window.requestAnimationFrame(flushSwipeBack);
  }

  // Where the surface is actually painted: touch samples are coalesced per frame, so the
  // release offset can sit a frame ahead of it. Settling from the painted step keeps the
  // page continuous at release instead of snapping it forward.
  function paintedSwipeBackStep(fallback) {
    const currentTime = Number(swipeAnimationRef.current?.currentTime);
    if (!Number.isFinite(currentTime)) return fallback;
    return Math.min(1, Math.max(0, currentTime / SWIPE_BACK_TRACK_MS));
  }

  // Replaces the tracking animation with a one-shot settle: the page keeps moving from
  // where the finger left it, over the time the remaining distance needs at that speed.
  // `swipe-armed` deliberately stays until the surface has arrived (stopSwipeBackMotion):
  // dropping it here releases the promoted layer and re-pauses every animation in the
  // directory while the page is still moving, which reads as a hitch in the fly-off.
  function settleSwipeBack(step, complete, duration, easing) {
    const surface = detailScreenRef.current;
    if (!surface) return null;
    const settle = surface.animate(
      [{ transform: `translate3d(${step * 100}%, 0px, 0px)` }, { transform: `translate3d(${complete ? 100 : 0}%, 0px, 0px)` }],
      { duration, easing, fill: 'both' },
    );
    swipeAnimationRef.current?.cancel();
    swipeAnimationRef.current = null;
    swipeSettleRef.current = settle;
    surface.classList.toggle('swipe-dismissing', complete);
    return settle;
  }

  /**
   * 收起详情页。收尾那一帧上挤着三笔重活：卸掉整棵详情树、目录几十个定时动画重新交给合成器、顶栏的
   * backdrop-filter 第一次渲染（一整屏背景模糊）——挤在一起就是滑退动画最后那一下的卡顿。交给
   * `createDismissHandoff` 排期：动画最后那一帧先画出去，再卸层。
   *
   * 滑退过来的（`keepDirectoryLive`）不再挂 `detail-closing`：手指一松开、`swipe-dismissing` 一挂上，目录的
   * 定时动画和顶栏模糊已经由 styles.css 那两条 `:has` 规则放回来了，再冻两帧看到的就是「收尾卡一下」。
   * 按钮返回那条路上没有动画，仍然靠 hold 把恢复推到卸层之后。
   */
  function dismissToDirectory({ keepDirectoryLive = false } = {}) {
    if (!dismissHandoffRef.current) {
      dismissHandoffRef.current = createDismissHandoff({
        // 挂到 <html> 上：React 会在这一帧重写 `.app-shell` 的 className，挂在那儿的类会被抹掉。
        addHold: () => document.documentElement.classList.add(DIRECTORY_HOLD_CLASS),
        removeHold: () => document.documentElement.classList.remove(DIRECTORY_HOLD_CLASS),
        unmount: () => onBackRef.current(),
      });
    }
    dismissHandoffRef.current({ hold: !keepDirectoryLive });
  }

  function finishSwipeBack(event) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    clearSwipeBackFrame();
    if (!start?.claimed) {
      stopSwipeBackMotion();
      return;
    }
    const touch = event.changedTouches?.[0];
    if (touch) {
      // Fold the last sample in, so a flick that ended between two frames still counts.
      start.velocity = swipeBackVelocity(start.velocity, {
        deltaX: touch.clientX - start.lastX,
        deltaMs: event.timeStamp - start.lastTime,
      });
      swipeOffsetRef.current = swipeBackOffset(start, { x: touch.clientX, y: touch.clientY });
    }
    const release = swipeBackRelease({
      offset: swipeOffsetRef.current,
      width: start.width,
      velocity: start.velocity,
    });
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reducedMotion ? 0 : release.durationMs;
    const settle = settleSwipeBack(paintedSwipeBackStep(release.step), release.complete, duration, release.easing);
    const finish = () => {
      if (release.complete) {
        // Leave the settle holding its last frame: the surface is unmounted on a later frame.
        swipeSettleRef.current = null;
        setSwipeBackInFlight(false);
        dismissToDirectory({ keepDirectoryLive: true });
        return;
      }
      stopSwipeBackMotion();
      flushDeferredRefresh();
    };
    if (!settle || duration <= 0) finish();
    else settle.onfinish = finish;
  }

  function cancelSwipeBack() {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    clearSwipeBackFrame();
    if (!start?.claimed) {
      stopSwipeBackMotion();
      return;
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const { step } = swipeBackRelease({ offset: swipeOffsetRef.current, width: start.width });
    const settle = settleSwipeBack(paintedSwipeBackStep(step), false, reducedMotion ? 0 : 180, SWIPE_BACK_CANCEL_EASING);
    const finish = () => {
      stopSwipeBackMotion();
      flushDeferredRefresh();
    };
    if (!settle || reducedMotion) finish();
    else settle.onfinish = finish;
  }

  // React attaches its touch listeners passively, so `preventDefault()` in a
  // synthetic touchmove never reaches the WebView: the scroll view keeps the
  // gesture, touch delivery stalls until it settles, and the pull finishes long
  // after the finger is gone. Own the listeners so a rightward pull is claimed —
  // and scrolling blocked — from the first few pixels of movement.
  useEffect(() => {
    swipeHandlersRef.current = { start: beginSwipeBack, move: moveSwipeBack, end: finishSwipeBack, cancel: cancelSwipeBack };
  });

  useEffect(() => {
    const surface = detailScreenRef.current;
    if (!surface) return undefined;
    const forward = (name) => (event) => swipeHandlersRef.current?.[name]?.(event);
    const handlers = {
      start: forward('start'),
      move: forward('move'),
      end: forward('end'),
      cancel: forward('cancel'),
    };
    surface.addEventListener('touchstart', handlers.start, { passive: true });
    surface.addEventListener('touchmove', handlers.move, { passive: false });
    surface.addEventListener('touchend', handlers.end, { passive: true });
    surface.addEventListener('touchcancel', handlers.cancel, { passive: true });
    return () => {
      surface.removeEventListener('touchstart', handlers.start);
      surface.removeEventListener('touchmove', handlers.move);
      surface.removeEventListener('touchend', handlers.end);
      surface.removeEventListener('touchcancel', handlers.cancel);
    };
  }, []);

  useEffect(() => () => stopSwipeBackMotion(), []);

  // 键盘跟着输入框走（见 ios-keyboard.js）：这个会话把会跟键盘移动的两块交给控制器——消息列表
  // （连窗口带内容）和输入框那一叠；离开会话时收回。
  useEffect(() => registerKeyboardSurface({ regionRef: messageRegionRef, scrollerRef: messageScrollRef, dockRef: composerDockRef }), []);

  function collapseComposer() {
    setComposerExpanded(false);
    messageInputRef.current?.blur();
  }

  useEffect(() => () => {
    composerImagesRef.current.forEach((image) => {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    });
  }, [id]);

  useEffect(() => {
    setTaskRuntimes({});
    releaseConversationImageUrls(id);
    optimisticUserMessagesRef.current = [];
    setOptimisticUserMessages([]);
    setConversationHydrated(false);
    loadedTraceIdsRef.current = new Set();
  }, [id]);

  const refresh = useCallback(async ({ keep = false } = {}) => {
    if (localStreamRef.current) return null;
    // 这份会话最大 1.7MB：解析一遍 + 整棵重渲染一次，落进手势或键盘动画里就是一帧几十毫秒。
    // 检查放在 fetch 之前——已经发出的请求收不回来，但至少别把这份活排到动画中间才开始。
    if (!keep && threadBusy()) {
      deferredRefreshRef.current = true;
      return null;
    }
    try {
      const nextConversation = await api.conversation(id);
      // A poll that resolves while a gesture owns the thread would rebuild the message list
      // under the finger; drop it here and let the post-gesture catch-up fetch it again.
      // `keep` is the pull-to-refresh call itself, which is the point of the gesture.
      if (!keep && threadBusy()) {
        deferredRefreshRef.current = true;
        return null;
      }
      // 内容没变就别写 state：写下去就是整棵详情树重渲染一次，而这轮轮询多半什么都没带回来。
      const signature = conversationSignature(nextConversation);
      if (signature !== conversationSignatureRef.current) {
        conversationSignatureRef.current = signature;
        setConversation(nextConversation);
      }
      setConversationHydrated(true);
      setError('');
      return nextConversation;
    } catch (nextError) {
      setError(nextError.message);
      return null;
    }
  }, [id]);

  // Same control as the directory, and the only way out of a detail that failed to load:
  // pulling the thread down retries the fetch that fills it.
  usePullToRefresh({
    listenRef: messageScrollRef,
    surfaceRef: messageBodyRef,
    indicatorRef: refreshIndicatorRef,
    canStart: () => (messageScrollRef.current?.scrollTop || 0) <= 0,
    onRefresh: async () => {
      await refresh({ keep: true });
      deferredRefreshRef.current = false;
    },
  });

  useEffect(() => {
    refresh();
    // A poll rebuilds and re-renders the whole thread; while a pull is on the way that
    // work would land mid-gesture, so it waits for the surface to settle.
    const timer = window.setInterval(() => {
      // `refresh` 自己会挡（这里不再重复一遍条件）：手势或键盘动画期间整圈跳过并记下 deferred，
      // 收敛后由 `flushDeferredRefresh` 补一次。
      refresh();
    }, CONVERSATION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setRunConfig(null);
    setRunConfigExpanded(false);
    setShowRunConfig(false);
    Promise.all([api.agents(), api.llmSettings()])
      .then(([agentPayload, llmPayload]) => {
        if (cancelled) return;
        setAgents(agentOptionsFromPayload(agentPayload));
        setProviders(providerOptionsFromSettings(llmPayload));
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError.message);
      });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!conversationHydrated || !conversation || !providers.length || runConfig) return;
    setRunConfig(resolveRunConfig(conversation, providers, agents));
  }, [agents, conversation, conversationHydrated, providers, runConfig]);

  useEffect(() => {
    const provider = providers.find((item) => item.id === runConfigRef.current?.providerId);
    if (!provider) {
      setModels([]);
      return undefined;
    }
    let cancelled = false;
    setModels(provider.models);
    setModelLoading(true);
    api.providerModels(provider)
      .then((payload) => {
        if (cancelled) return;
        const seen = new Set();
        const nextModels = (payload?.models || []).map((item) => {
          const modelId = String(typeof item === 'string' ? item : item?.id || '').trim();
          if (!modelId || seen.has(modelId)) return null;
          seen.add(modelId);
          return { id: modelId, label: String(typeof item === 'string' ? item : item?.label || modelId) };
        }).filter(Boolean);
        const available = withCurrentModel(nextModels.length ? nextModels : provider.models, runConfigRef.current?.modelId);
        setModels(available);
        setRunConfig((current) => {
          if (!current || current.providerId !== provider.id || available.some((item) => item.id === current.modelId)) return current;
          const defaultModel = String(payload?.default_model || provider.defaultModelId || available[0]?.id || '');
          return { ...current, modelId: available.some((item) => item.id === defaultModel) ? defaultModel : available[0]?.id || '' };
        });
      })
      .catch(() => {
        if (!cancelled) setModels(withCurrentModel(provider.models, runConfigRef.current?.modelId));
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false);
      });
    return () => { cancelled = true; };
  }, [providers, runConfig?.providerId]);

  const activeTask = useMemo(() => {
    const tasks = conversation?.tasks || [];
    return [...tasks].reverse().find((task) => ACTIVE_STATUSES.has(task.status)) || null;
  }, [conversation]);

  const tasksById = useMemo(() => new Map(
    (conversation?.tasks || []).map((task) => [task.task_id, task]),
  ), [conversation]);

  const loadTaskTrace = useCallback(async (taskId) => {
    if (!taskId || loadedTraceIdsRef.current.has(taskId)) return;
    loadedTraceIdsRef.current.add(taskId);
    try {
      const state = await taskRuntime.refresh(taskId);
      // A skipped attempt (backoff, or a request already in flight) is not a
      // loaded trace: drop the mark so the next expand retries it.
      if (!state) loadedTraceIdsRef.current.delete(taskId);
      else setTaskRuntimes((current) => ({ ...current, [taskId]: state }));
    } catch (nextError) {
      loadedTraceIdsRef.current.delete(taskId);
      setError(nextError.message);
      throw nextError;
    }
  }, []);

  const activeTaskId = liveRun?.taskId || activeTask?.task_id || null;
  const running = isCurrentTaskRunning(liveRun, activeTask);

  const stop = useCallback(async () => {
    if (!conversation || !running) return;
    setBusy(true);
    setError('');
    try {
      if (activeTaskId) await api.stopTask(activeTaskId);
      else await api.stopConversation(conversation.conversation_id);
      const cancelledAt = Date.now();
      const cancelledRun = liveRunRef.current ? { ...liveRunRef.current, status: 'cancelled', completedAt: cancelledAt } : null;
      liveRunRef.current = cancelledRun;
      flushLiveRun();
      const cancelledTaskId = activeTaskId || cancelledRun?.taskId;
      if (cancelledTaskId) {
        // The runtime never stores an assistant message for a cancelled task, so
        // keep the streamed trace locally instead of flashing it away.
        setTaskRuntimes((current) => (current[cancelledTaskId] ? current : {
          ...current,
          [cancelledTaskId]: { ...(cancelledRun || {}), taskId: cancelledTaskId, status: 'cancelled', completedAt: cancelledAt },
        }));
      }
      await refresh();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }, [activeTaskId, conversation, refresh, running]);

  useEffect(() => {
    const taskId = activeTask?.task_id;
    if (!taskId) {
      // A finished failure keeps its bubble: it holds the only copy of the reply.
      if (!localStreamRef.current && !isFailureStatus(liveRunRef.current?.status)) setLiveRun(null);
      return undefined;
    }

    let cancelled = false;
    // Repaint a task we already streamed this session before the next poll.
    const cached = localStreamRef.current ? null : taskRuntime.cache.state(taskId);
    if (cached) setLiveRun(cached);

    async function hydrateActiveTask() {
      if (localStreamRef.current) return;
      try {
        const state = await taskRuntime.refresh(taskId);
        if (!cancelled && state) setLiveRun(state);
      } catch (nextError) {
        if (!cancelled) setError(nextError.message);
      }
    }

    // A backgrounded app paints nothing: keep the payloads for when it does.
    function tick() {
      if (threadBusy()) return;
      if (document.visibilityState === 'hidden') return;
      hydrateActiveTask();
    }

    tick();
    const timer = window.setInterval(tick, 2000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeTask?.task_id]);

  useEffect(() => {
    if (!running) return undefined;
    const cancelOnEscape = (event) => {
      if (event.key !== 'Escape' || event.repeat || busy) return;
      event.preventDefault();
      stop();
    };
    document.addEventListener('keydown', cancelOnEscape);
    return () => document.removeEventListener('keydown', cancelOnEscape);
  }, [busy, running, stop]);

  useEffect(() => {
    if (!runConfigExpanded || showRunConfig) return undefined;
    const collapse = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !runConfigQuickRef.current?.contains(event.target)) {
        setRunConfigExpanded(false);
      }
    };
    document.addEventListener('pointerdown', collapse);
    document.addEventListener('keydown', collapse);
    return () => {
      document.removeEventListener('pointerdown', collapse);
      document.removeEventListener('keydown', collapse);
    };
  }, [runConfigExpanded, showRunConfig]);

  async function attachImages(files) {
    const available = Math.max(0, CHAT_IMAGE_MAX_COUNT - composerImagesRef.current.length);
    const drafts = Array.from(files || []).slice(0, available).map((file) => {
      const validationError = chatImageValidationError(file);
      return {
        id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: validationError ? '' : URL.createObjectURL(file),
        uploading: !validationError,
        error: validationError,
      };
    });
    if (!drafts.length) return;
    const nextImages = [...composerImagesRef.current, ...drafts];
    composerImagesRef.current = nextImages;
    setComposerImages(nextImages);
    await Promise.all(drafts.filter((image) => !image.error).map(async (image) => {
      try {
        const uploaded = await api.uploadImage(id, image.file);
        setComposerImages((current) => current.map((item) => item.id === image.id ? {
          ...item,
          uploading: false,
          imageId: uploaded.image_id,
          path: uploaded.path,
          mime: uploaded.mime,
        } : item));
      } catch (nextError) {
        setComposerImages((current) => current.map((item) => item.id === image.id
          ? { ...item, uploading: false, error: nextError.message }
          : item));
      }
    }));
  }

  function beginPhotoLongPress() {
    window.clearTimeout(photoLongPressTimerRef.current);
    photoLongPressTimerRef.current = window.setTimeout(() => {
      photoLongPressTimerRef.current = 0;
      photoLongPressRef.current = true;
      photoInputRef.current?.click();
    }, PHOTO_LONG_PRESS_MS);
  }

  function cancelPhotoLongPress() {
    window.clearTimeout(photoLongPressTimerRef.current);
    photoLongPressTimerRef.current = 0;
  }

  async function openPhotoPicker() {
    if (busy || composerImagesRef.current.length >= CHAT_IMAGE_MAX_COUNT) return;
    if (!hasNativePhotoPicker()) {
      photoInputRef.current?.click();
      return;
    }
    try {
      const files = await pickImagesFromLibrary({
        limit: remainingImageSlots(composerImagesRef.current.length, CHAT_IMAGE_MAX_COUNT),
      });
      if (files?.length) await attachImages(files);
    } catch (nextError) {
      if (isPhotoPickerCancellation(nextError)) return;
      setError(nextError?.message || 'Could not open the photo library.');
    }
  }

  function removeComposerImage(imageId) {
    const image = composerImagesRef.current.find((item) => item.id === imageId);
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    const nextImages = composerImagesRef.current.filter((item) => item.id !== imageId);
    composerImagesRef.current = nextImages;
    setComposerImages(nextImages);
  }

  async function submit(event) {
    event.preventDefault();
    const nextMessage = message.trim();
    const imageAttachments = composerImages.filter((image) => image.imageId && !image.error).map((image) => ({
      image_id: image.imageId,
      path: image.path,
      mime: image.mime,
    }));
    const steering = running;
    // 只带引用不发文字也是合法的一轮（runtime 的 TaskStreamRequest.message 允许空串）：
    // 那一段被选中的原文本身就是这轮要说的话。但 steering 带引用不行——annotations 只随
    // task.start 提交，所以运行中先把引用留在草稿里（下面那条 notice 会解释）。
    const hasAnnotations = annotationDrafts.length > 0;
    if ((!nextMessage && !imageAttachments.length && !hasAnnotations) || !conversation || (steering && (!activeTaskId || hasAnnotations)) || composerImages.some((image) => image.uploading) || (!steering && !runConfig)) return;
    // 引用与正文加起来最多 20,000 个字（桌面同款预算）。
    const commentsError = annotationDrafts.length ? annotationError(annotationDrafts, nextMessage) : '';
    setAnnotationNotice(commentsError);
    if (commentsError) return;
    const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const existingOccurrence = optimisticUserMessagesRef.current
      .filter((item) => item.text === nextMessage)
      .reduce((highest, item) => Math.max(highest, item.occurrence), 0);
    const occurrence = Math.max(
      userMessageOccurrenceCount(conversation.messages, nextMessage),
      existingOccurrence,
    ) + 1;
    // 乐观行把这一轮的引用一起背上：输入框里的草稿立刻让位给这行（服务端快照回来时
    // 再按 messageId 认领，见 model/message-annotations.js 的 visibleAnnotationDrafts）。
    const optimisticMessage = { id: optimisticId, text: nextMessage, images: imageAttachments, annotations: annotationDrafts, occurrence };
    const submittedComposerImages = composerImagesRef.current;
    let accepted = false;
    let releasedImages = false;
    const releaseSubmittedImages = () => {
      if (releasedImages) return;
      releasedImages = true;
      submittedComposerImages.forEach((image) => {
        if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      });
    };
    optimisticUserMessagesRef.current = [...optimisticUserMessagesRef.current, optimisticMessage];
    setOptimisticUserMessages(optimisticUserMessagesRef.current);
    composerImagesRef.current = [];
    setComposerImages([]);
    setMessage('');
    setComposerExpanded(false);
    messageInputRef.current?.blur();
    setBusy(true);
    setError('');
    try {
      if (steering) {
        await api.sendInput(activeTaskId, nextMessage, imageAttachments);
        accepted = true;
        releaseSubmittedImages();
        await refresh();
        return;
      }

      localStreamRef.current = true;
      // 第一条消息给会话起名：`New Chat` 这种占位名 + 还没跑过任务时，换成 `titleFromTaskText` 的
      // 一句话摘要（桌面在提交那一趟里做的是同一件事：`startDeploy` 算名字 + 客户端 PATCH）。
      // 服务端不会自己改名，所以这一步得在这里发；换名失败只报到错误条上，这一轮消息照发——
      // 收回去的是名字，不是消息。
      const nextTitle = conversationTitleForMessage(nextMessage);
      if (nextTitle && isPlaceholderConversationTitle(conversation.title || conversation.label) && !(conversation.tasks || []).length) {
        try {
          const renamed = await api.updateConversation(conversation.conversation_id, { title: nextTitle });
          conversationSignatureRef.current = conversationSignature(renamed);
          setConversation(renamed);
        } catch (renameError) {
          setError(renameError.message);
        }
      }
      // 本地草稿：任务号还没回来（第一个事件带到之前）时的壳。
      const initialRun = draftRuntimeTask();
      liveRunRef.current = initialRun;
      flushLiveRun();
      await api.startTask(
        conversation,
        nextMessage,
        imageAttachments,
        taskOptionsForRunConfig(runConfig, providers),
        (streamEvent) => {
          // 每个 token 一条事件：折进 ref，每帧最多往 React 递一次（见 `scheduleLiveRun`）。
          scheduleLiveRun(runtimeTaskWithEvent(liveRunRef.current, streamEvent));
        },
        () => {
          accepted = true;
          releaseSubmittedImages();
          setBusy(false);
        },
        annotationDrafts,
      );
      localStreamRef.current = false;
      const nextConversation = await refresh();
      const streamedRun = liveRunRef.current || {};
      const streamedTask = nextConversation?.tasks?.find((task) => task.task_id === streamedRun.taskId);
      const outcome = String(isFailureStatus(streamedRun.status)
        ? streamedRun.status : streamedTask?.status || streamedRun.status || 'done').toLowerCase();
      if (isFailureStatus(outcome)) {
        const failedRun = {
          ...streamedRun,
          taskId: streamedRun.taskId || streamedTask?.task_id || null,
          status: outcome,
          answerText: textContent(streamedTask?.answer_text || streamedRun.answerText || ''),
          error: streamedTask?.error || streamedRun.error || '',
          completedAt: streamedRun.completedAt || Date.now(),
        };
        liveRunRef.current = failedRun;
        flushLiveRun();
      } else {
        liveRunRef.current = null;
        flushLiveRun();
      }
    } catch (nextError) {
      // A steering send or a task the runtime never accepted: the message is not
      // queued anywhere, so hand the draft back instead of faking a reply for it.
      if (steering || !accepted) {
        optimisticUserMessagesRef.current = optimisticUserMessagesRef.current.filter((item) => item.id !== optimisticId);
        setOptimisticUserMessages(optimisticUserMessagesRef.current);
        composerImagesRef.current = submittedComposerImages;
        setComposerImages(submittedComposerImages);
        setMessage(nextMessage);
        setError(nextError.message);
        return;
      }
      // The run was accepted and then the stream broke: keep the work that did
      // arrive and report the failure underneath it.
      const failedAt = Date.now();
      const previousRun = liveRunRef.current || {};
      const failedRun = {
        ...previousRun,
        status: 'failed',
        answerText: textContent(previousRun.answerText || ''),
        error: nextError.message,
        createdAt: previousRun.createdAt || failedAt,
        completedAt: failedAt,
      };
      liveRunRef.current = failedRun;
      flushLiveRun();
      releaseSubmittedImages();
      setError(nextError.message);
    } finally {
      localStreamRef.current = false;
      setBusy(false);
    }
  }

  const selectedThinking = THINKING_OPTIONS.find((item) => item.id === runConfig?.thinking);
  const selectedThinkingIndex = Math.max(0, THINKING_OPTIONS.findIndex((item) => item.id === runConfig?.thinking));
  const selectedThinkingRatio = selectedThinkingIndex / (THINKING_OPTIONS.length - 1);
  const reasoningGaugeRotation = `${selectedThinkingIndex * 80 - 165}deg`;
  const reasoningProgressOffset = 20 - 40 * selectedThinkingRatio;
  const reasoningProgress = `calc(${selectedThinkingRatio * 100}% ${reasoningProgressOffset < 0 ? '-' : '+'} ${Math.abs(reasoningProgressOffset)}px)`;
  const selectedModel = models.find((item) => item.id === runConfig?.modelId);
  const compactModel = String(selectedModel?.label || runConfig?.modelId || '')
    .replace(/^gpt[-_]/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => /^\d/.test(part) ? part : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const reconnecting = connection && !connection.timedOut;
  // 会话的 agent 只在还没发过消息时能换（规则见 agent-binding.js）：runtime 在首个被接受的
  // chat turn 上写死绑定，之后再换一定 400，所以发过消息就锁上，新会话必须能选。
  const agentLocked = conversationHasSentMessage({ tasks: conversation?.tasks, messages: conversation?.messages });
  // A detail that never loaded is a dead end on its own — a banner over an empty thread.
  // The card below owns the way out, and the pull-to-refresh handler above retries it.
  const detailLoadFailed = !conversationHydrated && Boolean(error || connection) && !liveRun;
  // Every state change on this screen re-renders it; the thread below is memoized
  // so typing, the elapsed timer, polls and streamed events only redraw the parts
  // they actually change.
  const hidingLiveTask = Boolean(running && liveRun && activeTaskId);
  const visibleMessages = useMemo(() => (conversation?.messages || []).filter((item) => !(
    hidingLiveTask && item.role !== 'user' && item.task_id === activeTaskId
  )), [activeTaskId, conversation, hidingLiveTask]);
  const visibleOptimisticMessages = useMemo(() => optimisticUserMessages.filter((item) => (
    userMessageOccurrenceCount(visibleMessages, item.text) < item.occurrence
  )), [optimisticUserMessages, visibleMessages]);
  const orphanReplies = useMemo(() => orphanTaskReplies(conversation), [conversation]);
  const orphanReplyByAnchor = useMemo(() => orphanReplyAnchors(visibleMessages, orphanReplies), [orphanReplies, visibleMessages]);
  // Keep the live trace on screen between "stop" and the refreshed conversation
  // snapshot that carries the local reply for the cancelled task.
  const liveReplyPending = Boolean(liveRun && !running
    && isFailureStatus(liveRun.status)
    && !orphanReplies.has(liveRun.taskId)
    && !visibleMessages.some((item) => item.role !== 'user' && item.task_id === liveRun.taskId));
  // 行列表：持久化消息 + 没有落库回复的任务（取消/失败）+ 乐观用户消息 + 实时行。
  // 行对象在同内容时保持身份（chat-view.jsx 的 stabilizeRows），流式时只有最后
  // 那条实时行重画。
  const rows = useMemo(() => buildChatRows({
    conversationId: id,
    conversation,
    messages: visibleMessages,
    optimisticMessages: visibleOptimisticMessages,
    tasksById,
    runtimeTasks: taskRuntimes,
    liveRun,
    running,
    liveReplyPending,
    agentOptions: agents,
    orphanReplyByAnchor,
  }), [agents, conversation, id, liveReplyPending, liveRun, orphanReplyByAnchor, running, taskRuntimes, tasksById, visibleMessages, visibleOptimisticMessages]);

  // 引用批注（桌面的「添加注释」）：语义全在桌面那几份里（模型 / 草稿 hook / 引用块 / 快捷键），
  // 这里把它们接到手机的行列表上——行的形状与桌面的 messages 同形（role、messageId、status、
  // annotations），所以模型层一行也不用改。
  const selectAnnotationMessages = useMemo(() => createAnnotationMessageSelector(), []);
  const annotationMessages = useMemo(() => selectAnnotationMessages(rows, id), [id, rows, selectAnnotationMessages]);
  const { items: annotationSnapshots, update: updateAnnotations, storageError: annotationStorageError } = useAnnotationDraft(id, annotationMessages);
  const annotationDrafts = useMemo(() => visibleAnnotationDrafts(annotationSnapshots, annotationMessages), [annotationMessages, annotationSnapshots]);
  // 编号是会话级的：引用块上的号码、输入框里的草稿、发出去的那条引用要显示同一个号。
  const annotationNumbers = useMemo(() => numberAnnotations(annotationMessages, annotationDrafts), [annotationDrafts, annotationMessages]);
  // 正文里要带底色的句子：发出去的那几条 + 手里还没发的草稿（桌面同一份算法）。
  const highlightedAnnotations = useMemo(() => [
    ...annotationMessages.filter(isSubmittedAnnotationMessage).flatMap((item) => (item.annotations || [])
      .map((annotation) => ({ item: annotation, key: `${item.messageId || item.id}:${annotation.id}` }))),
    ...annotationDrafts.map((item) => ({ item, key: `draft:${item.id}` })),
  ], [annotationDrafts, annotationMessages]);
  const [annotationNotice, setAnnotationNotice] = useState('');
  const annotationUiRef = useRef(null);
  const jumpToAnnotation = useCallback((item) => annotationUiRef.current?.jump(item), []);
  const editAnnotation = useCallback((item) => annotationUiRef.current?.edit(item), []);
  // 与桌面 ChatPanel 同一套判定：先拿整份草稿验一遍（上限、长度、id 唯一），过了才落盘。
  const saveAnnotation = (item) => {
    const exists = annotationSnapshots.some((draft) => draft.id === item.id);
    const next = exists
      ? annotationSnapshots.map((draft) => draft.id === item.id ? item : draft)
      : [...annotationSnapshots, item];
    const problem = annotationError(next);
    setAnnotationNotice(problem);
    if (problem) return false;
    updateAnnotations((previous) => previous.some((draft) => draft.id === item.id)
      ? previous.map((draft) => draft.id === item.id ? item : draft)
      : [...previous, item]);
    return true;
  };
  useEffect(() => { setAnnotationNotice(''); }, [id]);

  return (
    <main className="detail-screen" ref={detailScreenRef}>
      <div className="detail-top">
        <header className="detail-header">
          <button className="icon-button ghost" onClick={() => dismissToDirectory()} aria-label="Back to conversations"><ArrowLeft size={22} /></button>
          <div><strong>{conversation?.title || 'Task'}</strong><span>{projectName || 'Project'}</span></div>
          <span className="header-spacer" />
        </header>
        {connection || error ? <div className={`detail-error-banner ${reconnecting ? 'connecting' : ''}`} role={reconnecting ? 'status' : 'alert'}>
          {reconnecting ? <RefreshCw className="spin" size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
          <span>{connection?.message || error}</span>
        </div> : null}
      </div>
      <div className="message-region" ref={messageRegionRef} onClick={collapseComposer}>
        <div className="detail-body" ref={messageBodyRef}>
          <span className="pull-refresh" ref={refreshIndicatorRef} aria-hidden="true"><LoaderCircle size={21} /></span>
          <div className="message-scroll" ref={messageScrollRef}>
            <ChatThread
              conversationId={id}
              rows={rows}
              loadTaskTrace={loadTaskTrace}
              annotationNumbers={annotationNumbers}
              onAnnotationJump={jumpToAnnotation}
              onPreviewImage={(image) => setPreviewImage({ src: image?.src, name: image?.title })}
            />
            {/* 插槽属于线程最新的一端，不属于历史之前：详情页一挂载就滚到最新消息并跟着它走，
                把卡片摆在整段历史之前等于一进来就被滚出视野（看起来只闪了一下就没了）。
                桌面端同样把审批行排在所有消息之后，卡片本体也是桌面那几个组件。 */}
            <ChatApprovalSlot conversationId={id} taskIds={taskIdsOf(conversation)} />
            {detailLoadFailed ? (
              <div className="load-failed"><CircleAlert size={28} aria-hidden="true" /><h2>Couldn’t load this conversation</h2><p>Pull down to try again.</p></div>
            ) : null}
            {!conversation && !detailLoadFailed ? <div className="center-state"><LoaderCircle className="spin" /></div> : null}
          </div>
        </div>
        <ScrollToBottomButton scrollRef={messageScrollRef} resetKey={id} />
      </div>
      {/* 选区菜单与评论编辑器（浮层，挂到 body）：listRef 就是线程本身，选中的那句从行上的
          data-annotation-source 认领（只有已完成回答的那层 div 带这个属性，跟桌面一致）。 */}
      <MessageAnnotations
        ref={annotationUiRef}
        listRef={messageScrollRef}
        highlightItems={highlightedAnnotations}
        drafts={annotationDrafts}
        onAdd={saveAnnotation}
        onSave={saveAnnotation}
        onSaved={() => messageInputRef.current?.focus()}
        onError={setAnnotationNotice}
      />
      <div className="composer-dock" ref={composerDockRef}>
        {runConfig && runConfigExpanded ? <div className={`run-config-quick-controls thinking-${runConfig.thinking}`} ref={runConfigQuickRef}>
          <button type="button" className="run-config-summary" onClick={() => setShowRunConfig(true)} disabled={running} aria-label="Open advanced run configuration">
            <span>{compactModel || 'Model'}</span><strong>{selectedThinking?.label || 'Thinking'}</strong><ChevronRight size={19} aria-hidden="true" />
          </button>
          <div className={`reasoning-slider thinking-${runConfig.thinking}`} style={{ '--reasoning-progress': reasoningProgress }}>
            <input
              type="range"
              min="0"
              max={THINKING_OPTIONS.length - 1}
              step="1"
              value={selectedThinkingIndex}
              disabled={running}
              aria-label="Thinking level"
              aria-valuetext={selectedThinking?.label || 'Thinking'}
              onChange={(event) => setRunConfig((current) => ({ ...current, thinking: THINKING_OPTIONS[Number(event.target.value)].id }))}
            />
            <span className="reasoning-marks" aria-hidden="true">
              {THINKING_OPTIONS.map((item, index) => <i className={index === selectedThinkingIndex ? 'active' : ''} key={item.id} />)}
            </span>
          </div>
        </div> : null}
        <form className={`composer ${runConfig && !runConfigExpanded ? 'has-config-icon' : ''} ${composerExpanded ? 'expanded' : ''}`} onSubmit={submit} onDragOver={(event) => {
          if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file')) event.preventDefault();
        }} onDrop={(event) => {
          const images = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'));
          if (!images.length) return;
          event.preventDefault();
          attachImages(images);
        }}>
          {/* 引用草稿：块本体是桌面的 QuoteBlock（点正文跳回原文、铅笔改评论、叉删掉），
              编号与会话里的引用一致。 */}
          {annotationDrafts.length ? <div className="haish-annotation-drafts" aria-label="Comment drafts">
            {annotationDrafts.map((item) => <QuoteBlock key={item.id} item={item} index={annotationNumbers.get(item.id)} preview
              onJump={jumpToAnnotation} onEdit={editAnnotation}
              onRemove={() => updateAnnotations((previous) => previous.filter((draft) => draft.id !== item.id))} />)}
          </div> : null}
          {(annotationNotice || annotationStorageError) ? <p className="haish-annotation-notice" role="status">{annotationNotice || annotationStorageError}</p> : null}
          {running && annotationDrafts.length ? <p className="haish-annotation-notice">Comments are saved as a draft. Send after the task finishes or stops.</p> : null}
          {composerImages.length ? <div className="composer-images" aria-label="Selected images">{composerImages.map((image) => (
            <div className={`composer-image ${image.uploading ? 'uploading' : ''} ${image.error ? 'error' : ''}`} key={image.id} title={image.error || image.file.name}>
              {image.previewUrl ? <button type="button" onClick={() => setPreviewImage({ src: image.previewUrl, name: image.file.name })} aria-label={`Preview ${image.file.name}`}><img src={image.previewUrl} alt="" /></button> : <span aria-hidden="true">!</span>}
              {image.uploading ? <LoaderCircle className="spin" size={20} aria-label="Uploading image" /> : null}
              <button type="button" className="composer-image-remove" onClick={() => removeComposerImage(image.id)} aria-label={`Remove ${image.file.name}`}><X size={13} /></button>
            </div>
          ))}</div> : null}
          {composerImages.some((image) => image.error) ? <p className="composer-image-error" role="alert">{composerImages.find((image) => image.error)?.error}</p> : null}
          <label htmlFor="task-message" className="sr-only">Send instructions</label>
          <textarea ref={messageInputRef} id="task-message" rows={1} value={message} disabled={busy} onFocus={() => setComposerExpanded(true)} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => {
            const images = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
            if (!images.length) return;
            event.preventDefault();
            attachImages(images);
          }} onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }} placeholder={running ? 'Add instructions…' : 'Continue this task…'} />
          <button
            type="button"
            className="composer-photo-button"
            disabled={busy || composerImages.length >= CHAT_IMAGE_MAX_COUNT}
            onClick={() => {
              if (photoLongPressRef.current) {
                photoLongPressRef.current = false;
                return;
              }
              openPhotoPicker();
            }}
            onPointerDown={beginPhotoLongPress}
            onPointerUp={cancelPhotoLongPress}
            onPointerCancel={cancelPhotoLongPress}
            onPointerLeave={cancelPhotoLongPress}
            onContextMenu={(event) => event.preventDefault()}
            aria-label="Choose photos from this device"
            title="Pick photos — press and hold for camera or files"
          >
            <ImagePlus size={25} aria-hidden="true" />
          </button>
          <input ref={photoInputRef} className="composer-file-input" type="file" accept="image/*" multiple tabIndex={-1} aria-hidden="true" disabled={composerImages.length >= CHAT_IMAGE_MAX_COUNT} onChange={(event) => {
            attachImages(event.target.files);
            event.target.value = '';
          }} />
          {runConfig && !runConfigExpanded ? <button type="button" className="run-config-icon-button" onClick={() => setRunConfigExpanded(true)} disabled={running} aria-label={`Show run configuration, thinking ${selectedThinking?.label || 'unknown'}`} aria-expanded="false"><svg className="run-config-gauge" style={{ '--gauge-rotation': reasoningGaugeRotation }} viewBox="0 0 24 24" aria-hidden="true"><path className="run-config-gauge-arc" d="M3.34 19a10 10 0 1 1 17.32 0" /><g className="run-config-gauge-needle"><path className="run-config-gauge-pointer" d="M10.9 13.4 12.6 15.1 18.65 7.35Z" /><circle cx="12" cy="14" r="1.8" /></g></svg></button> : null}
          {running && !message.trim() && !composerImages.some((image) => image.imageId && !image.error) ? (
            <button type="button" className="send-button stop" onClick={stop} disabled={busy} aria-label="Stop task">
              {/* 图标照桌面 chat 的发送/停止键：ArrowUp 是发，实心圆角方块是停
                  （40px 的桌面按钮里 22px 箭头 / 12px 方块，这里按钮是 48px，等比放大）。 */}
              {busy ? <span className="send-spinner" aria-hidden="true" /> : <Square className="send-icon stop-square" fill="currentColor" strokeWidth={0} aria-hidden="true" />}
            </button>
          ) : (
            <button className="send-button" disabled={busy || composerImages.some((image) => image.uploading) || (!message.trim() && !annotationDrafts.length && !composerImages.some((image) => image.imageId && !image.error)) || (running && annotationDrafts.length) || (!running && !runConfig)} aria-label={running ? 'Add instruction' : 'Send'}>
              {busy ? <span className="send-spinner" aria-hidden="true" /> : <ArrowUp className="send-icon" strokeWidth={2.3} aria-hidden="true" />}
            </button>
          )}
        </form>
      </div>
      {showRunConfig && runConfig ? <RunConfigSheet config={runConfig} agentLabel={conversation?.profile_display_name} agentLocked={agentLocked} agents={agents} providers={providers} models={models} modelLoading={modelLoading} onChange={setRunConfig} onClose={() => setShowRunConfig(false)} /> : null}
      <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />
    </main>
  );
}

function SettingsScreen({ status, onLogout, onBack }) {
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const listed = (await api.devices()).devices || [];
      const current = status.device;
      const merged = current && !listed.some((device) => device.device_id === current.device_id)
        ? [current, ...listed]
        : listed;
      setDevices(merged);
      setError('');
    } catch (nextError) {
      if (status.device) setDevices([status.device]);
      setError(nextError.message);
    }
  }, [status.device]);

  useEffect(() => { load(); }, [load]);

  async function revoke(id) {
    await api.revokeDevice(id);
    if (id === status.device?.device_id) await onLogout();
    else await load();
  }

  return (
    <main className="screen-content settings-screen">
      <header className="screen-header"><button className="icon-button ghost" onClick={onBack} aria-label="Back"><ArrowLeft size={22} /></button><div><h1>Setting</h1></div><span className="header-spacer" /></header>
      <section className="settings-card">
        <div className="settings-icon"><Laptop size={22} /></div>
        <div className="device-copy"><strong>Computer</strong><span>{status.computer_model || 'Computer'}</span></div>
        <span className={`connection-badge ${status.runtime_online ? 'online' : ''}`}>{status.runtime_online ? 'Online' : 'Offline'}</span>
      </section>
      <h2 className="section-title">Paired devices</h2>
      <section className="device-list">
        {devices.map((device) => (
          <div className="device-row" key={device.device_id}>
            <div className="device-icon"><Smartphone size={22} /></div>
            <div className="device-copy"><strong>{device.name}</strong><span>Last seen {formatDate(device.last_seen_at * 1000)}</span></div>
            <button className="text-button danger-text" onClick={() => revoke(device.device_id)}>{device.device_id === status.device?.device_id ? 'Sign out' : 'Revoke'}</button>
          </div>
        ))}
      </section>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="logout-button" onClick={onLogout}><LogOut size={19} />Sign out this device</button>
    </main>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('tasks');
  const [selectedId, setSelectedId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState({});
  const [approvals, setApprovals] = useState(null);
  const [loading, setLoading] = useState(true);
  // 行尾那个终态点的「看过」时刻表（见 conversation-status.js）：只对这台手机有意义，即用即存。
  const [seenAt, setSeenAt] = useState(() => loadConversationSeenAt(window.localStorage));
  const [fatalError, setFatalError] = useState('');
  const [runtimeOfflineSince, setRuntimeOfflineSince] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [startupRetrying, setStartupRetrying] = useState(true);
  const restoredConversationRef = useRef(false);
  const startupRequestRef = useRef(false);
  const detailOpenRef = useRef(false);
  const directorySignatureRef = useRef('');
  const statusSignatureRef = useRef('');
  // A failed directory load has to stay visible until the directory itself answers. The 5s
  // status poll succeeds on its own and used to clear the banner, so a list that never
  // loaded turned into “No conversations yet” a few seconds later — with nothing left to
  // pull down on.
  const directoryErrorRef = useRef(false);
  const approvalsSignatureRef = useRef('');
  const seenAtRef = useRef(seenAt);

  // 进会话与离开会话都把「看过」推到当下：行尾的终态点跟着灭（桌面「看过就熄灯」那条规矩）。
  const markSeen = useCallback((conversationId) => {
    if (!conversationId) return;
    const next = markConversationSeen(seenAtRef.current, conversationId, Date.now());
    seenAtRef.current = next;
    saveConversationSeenAt(window.localStorage, next);
    setSeenAt(next);
  }, []);

  const loadStatus = useCallback(async () => {
    const next = await api.status();
    if (api.isNative && !next.paired) await api.forgetConnection();
    if (!directoryErrorRef.current) setFatalError('');
    // 这一份几乎从不变化（`device.last_seen_at` 那种每次都在动的字段不在签名里，见
    // poll-signature.js）：一样就不写 state，不然整棵目录树每 5 秒跟着重渲染一次。
    const signature = statusSignature(next);
    if (signature === statusSignatureRef.current) return next;
    statusSignatureRef.current = signature;
    setStatus(next);
    return next;
  }, []);

  // The 5s poll used to hand every row a fresh object even when nothing changed,
  // so the list (and the screen sitting on top of it) re-rendered while the user
  // was typing. Compare the payload the UI renders and keep the old state when it
  // is identical.
  const loadApprovals = useCallback(async () => {
    try {
      const nextApprovals = await api.approvals();
      // 同一份快照顺手喂给 `window.haish` 的接缝：桌面的审批卡 / 提问卡 / 浏览器安装卡
      // 就是从那条事件流里拿数据的（见 src/haish-bridge.js）。手机上只留这一支轮询，
      // 桥不另开一条；返回的是「本地已经下过决定的请求摘掉之后」的那一份，列表行的
      // 状态坑位与横幅也照这一份画。
      const visible = publishApprovalState(nextApprovals);
      const signature = JSON.stringify(visible);
      if (signature === approvalsSignatureRef.current) return;
      approvalsSignatureRef.current = signature;
      setApprovals(visible);
    } catch { /* Pairing screen handles auth. */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const projectsResponse = await api.projects();
      // The directory answered: whatever the previous attempt reported is stale now.
      directoryErrorRef.current = false;
      setFatalError('');
      const nextProjects = projectsResponse.projects || [];
      const signature = JSON.stringify(nextProjects);
      if (signature === directorySignatureRef.current) return;
      directorySignatureRef.current = signature;
      const nextConversations = nextProjects.flatMap((project) => project.conversations || []);
      // 第一次在手机上见到的会话以现在为基线：装上手机之前跑完的任务不补灯。
      const seeded = seedConversationSeenAt(seenAtRef.current, nextConversations.map((item) => item.conversation_id), Date.now());
      if (seeded !== seenAtRef.current) {
        seenAtRef.current = seeded;
        saveConversationSeenAt(window.localStorage, seeded);
        setSeenAt(seeded);
      }
      setConversations(nextConversations);
      setProjects(nextProjects);
      const nextTasks = Object.fromEntries(nextConversations.flatMap((item) => item.tasks || []).map((task) => [task.task_id, task]));
      setTasks(nextTasks);
    } catch (error) {
      directoryErrorRef.current = true;
      setFatalError(error.message);
      if (error.status === 401) await loadStatus();
    } finally {
      setLoading(false);
    }
  }, [loadStatus]);

  // What the 5s poll does, and what a pull-down on the directory runs: the list is the one
  // screen whose own failure has no other way back.
  const refreshDirectory = useCallback(async () => {
    await Promise.allSettled([
      loadTasks(),
      loadStatus().catch((error) => setFatalError(error.message)),
      loadApprovals(),
    ]);
  }, [loadApprovals, loadStatus, loadTasks]);

  const connectAtStartup = useCallback(async () => {
    if (startupRequestRef.current) return;
    startupRequestRef.current = true;
    setStartupRetrying(true);
    try {
      const connection = await api.initialize();
      // iOS 会在键盘上方压一条系统表单栏（◀ ▶ Done）；它不属于本 App，开机就交给 Keyboard 插件隐藏。
      await hideKeyboardAccessoryBar();
      if (api.isNative && !connection) {
        statusSignatureRef.current = '';
        setStatus({ paired: false, runtime_online: false });
      } else await loadStatus();
    } catch (error) {
      setFatalError(error.message);
    } finally {
      startupRequestRef.current = false;
      setInitialized(true);
      setStartupRetrying(false);
    }
  }, [loadStatus]);

  useEffect(() => { connectAtStartup(); }, [connectAtStartup]);

  // 键盘和输入框一起走（见 ios-keyboard.js）：控制器维护布局里的键位高度、跟着键盘做动画的位移，
  // 与连接状态无关，所以尽早挂上；浏览器里它什么都不做。
  useEffect(() => mountKeyboardInset(), []);

  useEffect(() => {
    if (!initialized || status || startupRetrying) return undefined;
    const timer = window.setTimeout(connectAtStartup, 4_000);
    return () => window.clearTimeout(timer);
  }, [connectAtStartup, initialized, startupRetrying, status]);

  useEffect(() => {
    if (status?.runtime_online === false) setRuntimeOfflineSince((current) => current || Date.now());
    else setRuntimeOfflineSince(0);
  }, [status?.runtime_online]);

  useEffect(() => { detailOpenRef.current = Boolean(selectedId); }, [selectedId]);

  useEffect(() => {
    if (!status?.paired) return undefined;
    loadTasks();
    loadApprovals();
    let sinceDirectory = 0;
    const timer = window.setInterval(() => {
      // A pull (or a keyboard animation) owns the thread while it is on its way: no background
      // work may start under the finger.
      if (threadBusy()) return;
      loadStatus().catch((error) => setFatalError(error.message));
      loadApprovals();
      sinceDirectory += STATUS_POLL_MS;
      if (sinceDirectory < DIRECTORY_POLL_MS) return;
      sinceDirectory = 0;
      // The directory payload is ~3.5 MB and hands every row a fresh object; behind an
      // open detail none of that is visible, and the parse would land on the main thread
      // while the user reads or types. The list refreshes as it comes back into view.
      if (!detailOpenRef.current) loadTasks();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status?.paired, loadStatus, loadTasks, loadApprovals]);

  useEffect(() => {
    if (!status?.paired || loading || restoredConversationRef.current || selectedId || !conversations.length) return;
    restoredConversationRef.current = true;
    const lastId = storedConversationId();
    if (lastId && conversations.some((item) => item.conversation_id === lastId)) {
      markSeen(lastId);
      setSelectedId(lastId);
    }
  }, [conversations, loading, selectedId, status?.paired, markSeen]);

  // 传给 `ConversationList` 的几个回调必须是稳定的：它套了 memo，回调每次新建就等于没套。
  const createConversation = useCallback(async (projectId) => {
    const created = await api.createConversation(projectId);
    restoredConversationRef.current = true;
    saveStoredConversationId(created.conversation_id);
    markSeen(created.conversation_id);
    setSelectedId(created.conversation_id);
    // The detail screen can render immediately; refresh the directory in the background.
    loadTasks();
  }, [loadTasks, markSeen]);

  const openConversation = useCallback((conversation) => {
    restoredConversationRef.current = true;
    saveStoredConversationId(conversation.conversation_id);
    markSeen(conversation.conversation_id);
    setSelectedId(conversation.conversation_id);
  }, [markSeen]);

  // 「N actions waiting」那条横幅点进去：开正在等的那个会话（第一条带 conversation_id 的
  // 请求说了算，见 haish-bridge.js 的 waitingRequestConversation）。列表里还没刷新到它也能
  // 开——详情页自己去取。
  const openWaitingConversation = useCallback(() => {
    const conversationId = waitingRequestConversation(approvals);
    if (conversationId) openConversation({ conversation_id: conversationId });
  }, [approvals, openConversation]);

  const showSettings = useCallback(() => setTab('settings'), []);

  function closeConversation() {
    // 离开也算看过：在会话里看着它跑完的那一轮，回到列表不再亮灯。
    markSeen(selectedId);
    setSelectedId(null);
    // The directory poll is paused behind the detail, so the list is refreshed here as it
    // comes back into view instead of every 5s while nobody can see it. The payload is
    // megabytes and its parse lands on the main thread, so it waits for an idle moment
    // rather than stacking onto the swipe's last frames.
    const refreshDirectory = () => {
      if (!detailOpenRef.current) loadTasks();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(refreshDirectory, { timeout: 1000 });
    } else {
      window.setTimeout(refreshDirectory, 300);
    }
  }

  async function logout() {
    try { await api.logout(); } catch { /* Clear the local UI even if already revoked. */ }
    setSelectedId(null);
    saveStoredConversationId('');
    setConversations([]);
    directorySignatureRef.current = '';
    directoryErrorRef.current = false;
    approvalsSignatureRef.current = '';
    statusSignatureRef.current = '';
    // 换一台电脑配对时，上一台的会话 id 与「看过」时刻表一起丢掉。
    seenAtRef.current = {};
    saveConversationSeenAt(window.localStorage, {});
    setSeenAt({});
    setStatus({ paired: false, runtime_online: false });
  }

  if (!initialized || !status) return <ConnectionScreen error={initialized ? fatalError : ''} retrying={startupRetrying} onRetry={connectAtStartup} />;
  if (!status.paired) return <PairingScreen runtimeOnline={status.runtime_online} onPaired={loadStatus} />;
  const connection = runtimeConnectionState(status.runtime_online, runtimeOfflineSince);
  const selectedConversation = conversations.find((item) => item.conversation_id === selectedId) || null;
  const selectedProject = projects.find((project) => project.project_id === selectedConversation?.project_id);
  // The list stays mounted behind the detail page so a swipe back reveals it
  // instead of a blank screen; the detail is painted on top of the same tree.
  const detail = selectedId ? <ConversationDetail
    id={selectedId}
    projectName={selectedProject?.name || 'Project'}
    initialConversation={selectedConversation}
    onBack={closeConversation}
    connection={connection}
  /> : null;

  const approvalCount = (approvals?.pending?.length || 0) + (approvals?.pending_workflow_approvals?.length || 0) + (approvals?.pending_user_inputs?.length || 0);
  const waitingConversationId = waitingRequestConversation(approvals);
  const reconnecting = connection && !connection.timedOut;

  return (
    <div className={`app-shell ${selectedId ? 'detail-open' : ''}`}>
      {connection || fatalError ? <div className={`offline-banner ${reconnecting ? 'connecting' : ''}`} role={reconnecting ? 'status' : 'alert'}>
        {reconnecting ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <span>{connection?.message || fatalError}</span>
      </div> : null}
      {tab === 'tasks' ? (
        <>
          {approvalCount ? <button type="button" className="pending-banner" onClick={openWaitingConversation} disabled={!waitingConversationId}><ShieldCheck size={18} /><span>{approvalCount} {approvalCount === 1 ? 'action' : 'actions'} waiting</span>{waitingConversationId ? <ChevronRight size={17} aria-hidden="true" /> : null}</button> : null}
          <ConversationList projects={projects} conversations={conversations} tasks={tasks} status={status} approvals={approvals} loading={loading} error={fatalError} seenAt={seenAt} onRefresh={refreshDirectory} onOpen={openConversation} onNew={createConversation} onSettings={showSettings} />
        </>
      ) : <SettingsScreen status={status} onLogout={logout} onBack={() => setTab('tasks')} />}
      {detail}
    </div>
  );
}
