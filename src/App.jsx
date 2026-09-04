import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowRight,
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
  SquarePen,
  X,
} from 'lucide-react';
import { api, runtimeConnectionState } from './api.js';
import {
  CHAT_IMAGE_MAX_COUNT,
  chatMessageText,
  chatImageValidationError,
  messageImageRefs,
  userMessageOccurrenceCount,
} from './chat-images.js';
import penguinLogo from './assets/penguin_logo_user.png';
import stopIcon from '../../haish-agent/app-web/assets/ui/icons/stop.png';
import toolIcon from '../../haish-agent/app-web/assets/ui/icons/tool.png';
import readIcon from '../../haish-agent/app-web/assets/ui/icons/open-book.png';
import searchIcon from '../../haish-agent/app-web/assets/ui/icons/search-text.png';
import terminalIcon from '../../haish-agent/app-web/assets/ui/icons/terminal.png';
import webIcon from '../../haish-agent/app-web/assets/ui/icons/internet.png';
import writeIcon from '../../haish-agent/app-web/assets/ui/icons/copy-writing.png';
import listIcon from '../../haish-agent/app-web/assets/ui/icons/list-dir.png';
import globIcon from '../../haish-agent/app-web/assets/ui/icons/glob-files.png';
import visualIcon from '../../haish-agent/app-web/assets/ui/icons/visual-inspect.png';
import imageIcon from '../../haish-agent/app-web/assets/ui/icons/image-describe.png';
import subAgentIcon from '../../haish-agent/app-web/assets/ui/icons/chat.png';
import {
  categorizeToolCall,
  groupConsecutiveTools,
  timelineToolLabel,
} from '../../haish-agent/app-web/src/features/chat/model/chat-timeline.js';
import {
  buildSubAgentTimelineItems,
  buildToolView,
} from '../../haish-agent/app-web/src/features/chat/model/tool-view.js';
import { ScrollToBottomButton } from './ScrollToBottomButton.jsx';
import { SWIPE_BACK_EDGE_PX, isSwipeBackGesture, swipeBackOffset } from './swipe-back.js';
import {
  THINKING_OPTIONS,
  agentOptionsFromPayload,
  providerOptionsFromSettings,
  resolveRunConfig,
  taskOptionsForRunConfig,
} from './run-config.js';
import {
  applyTaskStreamEvent,
  formatElapsedDuration,
  hasVisibleTaskTools,
  isCurrentTaskRunning,
  isVisibleTaskTool,
  taskStreamState,
} from './task-stream.js';
import {
  isTaskActuallyActive,
  listTaskForConversation,
  runningConversationsFirst,
} from './conversation-order.js';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const MARKDOWN_PLUGINS = [remarkGfm];

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function textContent(content) {
  return chatMessageText(content);
}

function toolDisplayName(value) {
  return String(value || 'tool')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clientToolName(value) {
  const name = String(value || '').toLowerCase();
  return name === 'bash' || name === 'terminal' ? 'exec_command' : name;
}

function isVisibleTimelineItem(item) {
  if (item?.type !== 'tool' && item?.kind !== 'tool') return true;
  return isVisibleTaskTool(clientToolName(item.name || item.toolName));
}

function toolIconFor(value) {
  const name = String(value || '').toLowerCase();
  if (name === 'vision_analyze' || name === 'visual_inspect') return visualIcon;
  if (name === 'image_describe') return imageIcon;
  if (name.includes('dispatch_sub_agent') || name.includes('sub_agent') || name.includes('subagent')) return subAgentIcon;
  if (name === 'list_dir') return listIcon;
  if (name === 'glob_files') return globIcon;
  if (['read_file', 'list_dir', 'cat_file', 'view_file', 'open_file'].includes(name) || name.includes('read_text')) return readIcon;
  if (['glob_files', 'search_text', 'grep'].includes(name) || (name.includes('search') && !name.includes('web'))) return searchIcon;
  if (['exec_command', 'write_stdin', 'bash', 'terminal'].includes(name)) return terminalIcon;
  if (name.includes('web') || name.includes('fetch') || name.includes('http') || name.endsWith('_url')) return webIcon;
  if (name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('file')) return writeIcon;
  return toolIcon;
}

const TOOL_CARD_NAMES = {
  write_file: 'Wrote',
  edit_file: 'Edited',
  replace_lines: 'Replaced Lines',
  multi_edit: 'Edited',
  apply_patch: 'Patched',
  create_file: 'Created',
  delete_file: 'Deleted',
  copy_file: 'Copied',
  create_dir: 'Created Dir',
  read_file: 'Read',
  search_text: 'Search Text',
  glob_files: 'Glob Files',
  list_dir: 'List Dir',
  exec_command: 'Shell',
  bash: 'Shell',
  terminal: 'Shell',
  write_stdin: 'Process',
  dispatch_sub_agent: 'Sub-agent',
  sub_agent: 'Sub-agent',
  subagent: 'Sub-agent',
  vision_analyze: 'Visual Analyze',
  visual_inspect: 'Visual Inspect',
  image_describe: 'Image Describe',
  acceptance_check: 'Acceptance Check',
};

function processFileName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
}

function toolHeadParts(item, view) {
  const rawName = item.name || item.toolName;
  const name = String(rawName || '').toLowerCase();
  const cardName = TOOL_CARD_NAMES[name] || toolDisplayName(rawName);
  if (item.category === 'subagent') {
    return { cardName, argument: view.role || view.task || item.inputSummary || '' };
  }
  if (view.isVision) {
    return { cardName, argument: processFileName(view.mediaPath) || view.visionMode || view.task || '' };
  }
  const label = String(view.label || '');
  const isRawName = label.replace(/[_-]+/g, ' ').toLowerCase() === name.replace(/[_-]+/g, ' ');
  const labelArgument = isRawName ? (item.inputSummary || '') : label.toLowerCase().startsWith(cardName.toLowerCase())
    ? label.slice(cardName.length).trim()
    : (label || item.inputSummary || '');
  const argument = labelArgument || (view.mode === 'terminal' ? view.command : '') || item.inputSummary || '';
  return { cardName, argument };
}

function ProcessAnswer({ children, text }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = String(text || '').length > 900;
  return <div className={`tool-process-answer ${expanded ? 'expanded' : ''} ${collapsible ? 'collapsible' : ''}`}>
    <div className="tool-process-answer-body">{children}</div>
    {collapsible ? <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Collapse' : 'View All'}</button> : null}
  </div>;
}

function ToolTerminalOutput({ text, running, stderr = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && running) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, running]);
  if (!text) return null;
  return <pre ref={ref} className={`tool-terminal-output ${stderr ? 'stderr' : ''}`}>{text}</pre>;
}

function ToolTraceBody({ view }) {
  if (view.mode === 'terminal') {
    return <div className="tool-terminal-frame">
      <div className="tool-terminal-bar">
        <span className="tool-terminal-dots" aria-hidden="true"><span /><span /><span /></span>
        <span className="tool-terminal-cwd">{view.cwd || 'Terminal'}</span>
        {view.running || (view.exitCode !== undefined && view.exitCode !== '')
          ? <span className={`tool-terminal-state ${view.running ? 'running' : ''}`}>{view.running ? 'running' : `exit ${view.exitCode}`}</span>
          : <span />}
      </div>
      {view.command ? <div className="tool-terminal-command"><span className="tool-terminal-prompt" aria-hidden="true">$</span><span className="tool-terminal-command-text">{view.command}</span></div> : null}
      <ToolTerminalOutput text={view.stdout} running={view.running} />
      <ToolTerminalOutput text={view.stderr} running={view.running} stderr />
      {view.running && !view.stdout && !view.stderr ? <div className="tool-terminal-waiting">Waiting for output<span className="tool-terminal-cursor" aria-hidden="true" /></div> : null}
    </div>;
  }
  if (view.mode === 'diff') {
    return view.body ? <pre className="tool-diff">{view.body.split('\n').map((line, index) => {
      const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'remove'
          : line.startsWith('@@') ? 'hunk' : 'context';
      return <span className={kind} key={`${index}-${line}`}>{line || ' '}</span>;
    })}</pre> : null;
  }
  if (view.mode === 'process') {
    const nested = groupConsecutiveTools(buildSubAgentTimelineItems(view).filter(isVisibleTimelineItem));
    const activity = view.streamAnswerText || view.streamLines?.map((line) => line.text).filter(Boolean).join('\n');
    const answer = view.finalText || (!nested.length ? activity : '');
    const fields = [
      view.role ? ['Role', view.role, false] : null,
      view.systemPrompt ? ['System Prompt', view.systemPrompt, true] : null,
      view.task ? ['Task', view.task, true] : null,
    ].filter(Boolean);
    return <div className="tool-process-conversation">
      {fields.length || view.mediaPath ? <div className="tool-process-bubble request">
        {view.mediaPath ? <div className="tool-process-attachment"><span className="tool-trace-icon" style={{ '--tool-trace-icon': `url(${view.isVision ? visualIcon : subAgentIcon})` }} aria-hidden="true" /><span title={view.mediaPath}>{processFileName(view.mediaPath)}</span>{view.visionMode ? <em>{view.visionMode}</em> : null}</div> : null}
        {fields.length ? <div className="tool-process-fields">{fields.map(([label, value, markdown]) => <div className={`tool-process-field ${markdown ? 'multiline' : ''}`} key={label}>
          <span>{label}</span>
          <div>{markdown ? <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{String(value)}</ReactMarkdown> : value}</div>
        </div>)}</div> : null}
      </div> : null}
      {nested.length && !view.finalText ? <div className="tool-process-timeline">{nested.map((item) => item.kind === 'text'
        ? <div className="tool-process-stream-text" key={item.id}>{item.text}</div>
        : <ToolTimelineItem item={item} key={item.id} />)}</div> : null}
      {answer ? <div className="tool-process-bubble response">
        <ProcessAnswer text={answer}>{view.isVision ? <p>{answer}</p> : <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{answer}</ReactMarkdown>}</ProcessAnswer>
      </div> : null}
    </div>;
  }
  const request = view.requestJson || '';
  const response = view.responseJson || view.body || '';
  return request || response ? <div className="tool-json-pair">
    {request ? <div><span>Input</span><pre>{request}</pre></div> : null}
    {response ? <div><span>Result</span><pre>{response}</pre></div> : null}
  </div> : null;
}

function ToolTraceCard({ item }) {
  const rawName = item.name || item.toolName;
  const view = buildToolView({ ...item, toolName: clientToolName(rawName) });
  const { cardName, argument } = toolHeadParts(item, view);
  const hasDetails = view.mode === 'terminal'
    ? Boolean(view.command || view.stdout || view.stderr || view.running)
    : view.mode === 'process'
      ? Boolean(view.task || view.mediaPath || view.finalText || view.streamAnswerText || view.streamLines?.length || view.progressEvents?.length)
      : view.mode === 'diff'
        ? Boolean(view.body)
        : view.mode === 'json'
          ? Boolean(view.requestJson || view.responseJson || view.body)
          : false;
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-trace-card ${item.status || 'running'} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="tool-trace-head"
        aria-label={`${cardName} ${item.status || 'running'}`}
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        onClick={() => hasDetails && setOpen((value) => !value)}
      >
        <span className="tool-trace-status" aria-hidden="true" />
        <span className="tool-trace-icon" style={{ '--tool-trace-icon': `url(${toolIconFor(rawName)})` }} aria-hidden="true" />
        <strong className="tool-trace-name">{cardName}</strong>
        {argument ? <span className="tool-trace-argument" title={argument}>{argument}</span> : null}
        {hasDetails ? <ChevronRight className="tool-trace-chevron" size={14} aria-hidden="true" /> : null}
      </button>
      {open && hasDetails ? <div className="tool-trace-details"><ToolTraceBody view={view} /></div> : null}
    </div>
  );
}

function ToolTraceGroup({ item }) {
  const [open, setOpen] = useState(false);
  const tools = Array.isArray(item.tools) ? item.tools : [];
  return (
    <div className={`tool-trace-group ${item.status || 'done'} ${open ? 'open' : ''}`}>
      <button type="button" className="tool-trace-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-trace-status" aria-hidden="true" />
        <span className="tool-trace-icon" style={{ '--tool-trace-icon': `url(${toolIcon})` }} aria-hidden="true" />
        <strong className="tool-trace-group-summary">{item.summary || `used ${tools.length} tools`}</strong>
        <span className="tool-trace-count">{tools.length}</span>
        <ChevronRight className="tool-trace-chevron" size={14} aria-hidden="true" />
      </button>
      {open ? <div className="tool-trace-group-body">
        {tools.map((tool) => <ToolTraceCard item={tool} key={tool.id} />)}
      </div> : null}
    </div>
  );
}

function ToolTimelineItem({ item }) {
  return item.kind === 'tool_group' ? <ToolTraceGroup item={item} /> : <ToolTraceCard item={item} />;
}

function TodoPanel({ todos, running }) {
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  if (!todos?.length) return null;
  const inProgress = todos.filter((item) => item.status === 'in_progress');
  const pending = todos.filter((item) => item.status === 'pending');
  const completed = todos.filter((item) => item.status === 'completed');
  const visibleCompleted = showAllCompleted ? completed : completed.slice(-2);
  const hiddenCount = completed.length - visibleCompleted.length;
  const visible = [...inProgress, ...pending, ...visibleCompleted];
  return <div className="task-todo-panel" role="list" aria-label="Task plan">
    {visible.map((todo, index) => <div className={`task-todo-item status-${todo.status}`} role="listitem" key={`${todo.status}-${index}-${todo.content}`}>
      <span className={`task-todo-icon ${todo.status}`} aria-label={todo.status.replace('_', ' ')}>
        {todo.status === 'completed' ? <Check size={10} aria-hidden="true" /> : todo.status === 'in_progress' ? <span className={`task-todo-spinner ${running ? 'live' : ''}`} /> : null}
      </span>
      <span className="task-todo-content">{todo.content}</span>
    </div>)}
    {hiddenCount > 0 ? <button type="button" className="task-todo-expand" onClick={() => setShowAllCompleted(true)}>… +{hiddenCount} completed</button> : null}
  </div>;
}

function traceTimeline(segments) {
  return groupConsecutiveTools(segments.map((item) => {
    if (item.type !== 'tool') return { ...item, kind: 'text' };
    const call = { ...item, toolName: clientToolName(item.name) };
    const category = categorizeToolCall(call);
    return { ...call, kind: 'tool', category, label: timelineToolLabel(call, category) };
  }));
}

function visibleTaskTraceSegments(state, running) {
  if (!state) return [];
  const finalText = String(state.text || '').trim();
  return (state.segments || []).filter((item) => {
    if (item.type === 'tool') return isVisibleTimelineItem(item);
    if (running) return Boolean(item.text);
    if (item.source === 'final') return false;
    return String(item.text || '').trim() !== finalText;
  });
}

function TaskTrace({ state, running = false }) {
  if (!state) return null;
  const segments = visibleTaskTraceSegments(state, running);
  if (!running && !segments.length && !state.latestTodos?.length) return null;
  const timeline = traceTimeline(segments);
  return (
    <section className={`agent-trace ${running ? 'running' : 'complete'}`} aria-label="Assistant activity">
      <div className="agent-trace-content">
        {timeline.map((item) => item.kind === 'tool_group'
          ? <ToolTraceGroup item={item} key={item.id} />
          : item.type === 'tool'
            ? <ToolTraceCard item={item} key={item.id} />
            : <div className={`trace-text ${item.source || 'unknown'}`} key={item.id}><ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{item.text}</ReactMarkdown></div>)}
        {running ? <div className="agent-phase" role="status" aria-live="polite" aria-label={state.activity || 'Agent activity'}><span className="agent-phase-spark agent-phase-gradient" aria-hidden="true">*</span><span className="agent-phase-verb agent-phase-gradient" aria-hidden="true" /></div> : null}
        <TodoPanel todos={state.latestTodos} running={running} />
      </div>
    </section>
  );
}

function TaskTraceDisclosure({ state, running = false, elapsed = '', onLoad }) {
  const [expanded, setExpanded] = useState(false);
  const probeRef = useRef(null);
  useEffect(() => {
    if (running || state || !onLoad || !probeRef.current) return undefined;
    const probe = probeRef.current;
    const load = () => Promise.resolve(onLoad()).catch(() => {});
    if (!window.IntersectionObserver) {
      load();
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      load();
    }, { rootMargin: '160px 0px' });
    observer.observe(probe);
    return () => observer.disconnect();
  }, [onLoad, running, state]);
  const hasTools = hasVisibleTaskTools(state);
  if (!running && !state) return <span className="task-trace-probe" ref={probeRef} aria-hidden="true" />;
  const hasTrace = running ? Boolean(state) : hasTools;
  if (!hasTrace) return null;

  function toggle() {
    setExpanded((value) => !value);
  }

  return <>
    {elapsed && hasTools ? running
      ? <div className="task-elapsed-pill" aria-label={`Elapsed time ${elapsed}`}>{elapsed}</div>
      : <button type="button" className={`task-trace-toggle ${expanded ? 'expanded' : ''}`} aria-expanded={expanded} onClick={toggle}>
        <ChevronRight size={14} aria-hidden="true" /><span>{elapsed}</span>
      </button> : null}
    {running || (expanded && state) ? <TaskTrace state={state} running={running} /> : null}
  </>;
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

function ApprovalCard({ approvals, onResolved }) {
  const tool = approvals?.pending?.[0];
  const workflow = approvals?.pending_workflow_approvals?.[0];
  const input = approvals?.pending_user_inputs?.[0];
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = tool || workflow || input;
  if (!pending) return null;

  async function act(action) {
    setBusy(true);
    try {
      if (tool) await api.resolveApproval(tool.request_id, action);
      if (workflow) await api.resolveWorkflow(workflow.request_id, action, action === 'reject' ? answer || 'Rejected remotely' : '');
      if (input) {
        const question = input.questions?.[0];
        await api.resolveInput(input.request_id, [{ question_id: question?.id, kind: 'freeform', text: answer }]);
      }
      setAnswer('');
      await onResolved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="approval-card" aria-live="polite">
      <div className="approval-icon"><ShieldCheck size={20} /></div>
      <div className="approval-copy">
        <p className="eyebrow">ACTION REQUIRED</p>
        <h2>{tool?.tool_name || workflow?.title || input?.questions?.[0]?.header || 'Agent is waiting'}</h2>
        <p>{tool?.raw_command || workflow?.summaryText || input?.questions?.[0]?.question || 'Confirm whether to continue.'}</p>
      </div>
      {(workflow || input) ? (
        <label className="approval-feedback">
          <span>{input ? 'Your answer' : 'Reason for rejection (optional)'}</span>
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={2} />
        </label>
      ) : null}
      <div className="approval-actions">
        {!input ? <button className="secondary-button danger-text" disabled={busy} onClick={() => act(tool ? 'deny' : 'reject')}><X size={18} />Reject</button> : null}
        <button className="primary-button compact" disabled={busy || (input && !answer.trim())} onClick={() => act(tool ? 'allow_once' : workflow ? 'approve' : 'answer')}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}
          {input ? 'Submit answer' : 'Allow'}
        </button>
      </div>
    </section>
  );
}

function ConversationRow({ conversation, task, onOpen }) {
  const running = isTaskActuallyActive(task);
  return (
    <button className="conversation-row" onClick={() => onOpen(conversation)}>
      <span className="conversation-title">{conversation.title || conversation.label}</span>
      {running ? <LoaderCircle className="spin conversation-running" size={17} aria-label="Running" /> : null}
    </button>
  );
}

function ProjectGroup({ project, tasks, onOpen, onNew }) {
  const [open, setOpen] = useState(true);
  const orderedConversations = runningConversationsFirst(project.conversations, tasks);
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
        {orderedConversations.map((conversation) => <ConversationRow key={conversation.conversation_id} conversation={conversation} task={listTaskForConversation(conversation, tasks)} onOpen={onOpen} />)}
        {!project.conversations.length ? <p className="project-empty">No conversations yet</p> : null}
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

function RunConfigSheet({ config, agentLabel, agents, providers, models, modelLoading, onChange, onClose }) {
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
    { id: 'agent', label: 'Agent', value: config.agentId, displayValue: agentLabel, options: agents, readOnly: true },
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
              {field.readOnly ? <div className="run-config-field locked" aria-label={`${field.label} ${field.displayValue || selected?.label || field.value}, fixed for this conversation`}>
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

function ConversationList({ projects, conversations, tasks, status, loading, onOpen, onNew, onSettings }) {
  const [query, setQuery] = useState('');
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
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

  function startNew() {
    if (projects.length <= 1) onNew(projects[0]?.project_id);
    else setShowProjectPicker(true);
  }

  return (
    <main className="remote-home">
      <div className="remote-topbar">
        <header className="remote-header">
          <img className="header-brand" src={penguinLogo} alt="" draggable="false" />
          <div className="remote-title"><h1>Haish</h1><p className={status.runtime_online ? 'online' : ''}><span className="status-dot" /> <Laptop size={15} /> {status.computer_model || 'Computer'}</p></div>
          <button className="icon-button ghost" onClick={onSettings} aria-label="Setting"><MoreHorizontal size={26} /></button>
        </header>
        <label className="search-field"><Search size={23} aria-hidden="true" /><span className="sr-only">Search conversations</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /></label>
      </div>
      {loading && conversations.length === 0 ? <div className="center-state"><LoaderCircle className="spin" /><span>Syncing…</span></div> : null}
      {!loading && conversations.length === 0 ? (
        <div className="empty-state"><Folder size={30} /><h2>No conversations yet</h2><p>Create a task and it will appear on your computer.</p></div>
      ) : null}
      <div className="directory-list">
        {pinned.length ? <section className="pinned-group"><button className="section-toggle" onClick={() => setPinnedOpen((value) => !value)} aria-expanded={pinnedOpen}><Pin size={15} />Pinned<span>{pinned.length}</span><ChevronDown className="disclosure" size={16} /></button>{pinnedOpen ? <div className="pinned-list">{pinned.map((conversation) => <ConversationRow key={conversation.conversation_id} conversation={conversation} task={listTaskForConversation(conversation, tasks)} onOpen={onOpen} />)}</div> : null}</section> : null}
        {visibleProjects.map((project) => <ProjectGroup key={project.project_id} project={project} tasks={tasks} onOpen={onOpen} onNew={onNew} />)}
        {ungrouped.length ? <ProjectGroup project={{ project_id: '', name: 'Other conversations', conversations: ungrouped }} tasks={tasks} onOpen={onOpen} onNew={onNew} /> : null}
        {!loading && query && !pinned.length && !visibleProjects.length && !ungrouped.length ? <p className="no-results">No matching conversations</p> : null}
      </div>
      <div className="new-task-dock"><button className="new-task-button" onClick={startNew}><span className="new-task-icon"><Plus size={20} /></span><span>New task</span></button></div>
      {showProjectPicker ? <ProjectPicker projects={projects} onChoose={(projectId) => { setShowProjectPicker(false); onNew(projectId); }} onClose={() => setShowProjectPicker(false)} /> : null}
    </main>
  );
}

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

function MessageImage({ conversationId, image, onPreview }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    api.imagePreview(conversationId, image.path)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, image.path]);

  return (
    <button
      type="button"
      className="message-image"
      disabled={!src}
      onClick={() => onPreview({ src, name: image.path?.split('/').pop() })}
      aria-label={failed ? 'Attached image failed to load' : 'Preview attached image'}
    >
      {src ? <img src={src} alt="" loading="lazy" /> : failed ? <CircleAlert size={20} /> : <LoaderCircle className="spin" size={20} />}
    </button>
  );
}

function ConversationDetail({ id, initialConversation, onBack, approvals, refreshApprovals, connection }) {
  const [conversation, setConversation] = useState(initialConversation || null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [liveRun, setLiveRun] = useState(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState([]);
  const [composerImages, setComposerImages] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  const [taskTraces, setTaskTraces] = useState({});
  const [now, setNow] = useState(Date.now());
  const [agents, setAgents] = useState([]);
  const [providers, setProviders] = useState([]);
  const [runConfig, setRunConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [runConfigExpanded, setRunConfigExpanded] = useState(false);
  const [showRunConfig, setShowRunConfig] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const messageScrollRef = useRef(null);
  const messageInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const detailScreenRef = useRef(null);
  const swipeStartRef = useRef(null);
  const swipeOffsetRef = useRef(0);
  const swipeTimerRef = useRef(null);
  const composerImagesRef = useRef([]);
  const optimisticUserMessagesRef = useRef([]);
  const runConfigQuickRef = useRef(null);
  const localStreamRef = useRef(false);
  const liveRunRef = useRef(null);
  const loadedTraceIdsRef = useRef(new Set());

  useEffect(() => { liveRunRef.current = liveRun; }, [liveRun]);
  useEffect(() => { composerImagesRef.current = composerImages; }, [composerImages]);
  useEffect(() => { optimisticUserMessagesRef.current = optimisticUserMessages; }, [optimisticUserMessages]);

  function setSwipeBackPosition(offset) {
    swipeOffsetRef.current = offset;
    detailScreenRef.current?.style.setProperty('--swipe-back-offset', `${offset}px`);
  }

  function clearSwipeBackTimer() {
    if (swipeTimerRef.current) window.clearTimeout(swipeTimerRef.current);
    swipeTimerRef.current = null;
  }

  function resetSwipeBackSurface() {
    const surface = detailScreenRef.current;
    if (!surface) return;
    surface.classList.remove('swipe-tracking', 'swipe-settling', 'swipe-dismissing');
    surface.style.removeProperty('--swipe-back-duration');
  }

  function startSwipeBack(event) {
    if (event.touches.length !== 1 || previewImage || showRunConfig) return;
    const touch = event.touches[0];
    if (touch.clientX > SWIPE_BACK_EDGE_PX) return;
    clearSwipeBackTimer();
    resetSwipeBackSurface();
    setSwipeBackPosition(0);
    swipeStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      startedAt: performance.now(),
      axis: null,
    };
  }

  function moveSwipeBack(event) {
    const start = swipeStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = Math.abs(touch.clientY - start.y);
    if (!start.axis && Math.max(Math.abs(deltaX), deltaY) < 7) return;
    if (!start.axis) {
      if (deltaX > 0 && deltaX > deltaY * 1.15) start.axis = 'horizontal';
      else if (deltaY > Math.abs(deltaX)) start.axis = 'vertical';
    }
    if (start.axis === 'vertical' || deltaX < 0) {
      swipeStartRef.current = null;
      return;
    }
    if (start.axis !== 'horizontal') return;

    if (event.cancelable) event.preventDefault();
    const offset = swipeBackOffset(start, { x: touch.clientX, y: touch.clientY });
    detailScreenRef.current?.classList.add('swipe-tracking');
    setSwipeBackPosition(offset);
  }

  function finishSwipeBack(event) {
    const start = swipeStartRef.current;
    const touch = event.changedTouches[0];
    swipeStartRef.current = null;
    const surface = detailScreenRef.current;
    if (!start || !touch || !surface || start.axis !== 'horizontal') return;

    const width = surface.getBoundingClientRect().width || window.innerWidth;
    const complete = isSwipeBackGesture(
      start,
      { x: touch.clientX, y: touch.clientY },
      { width, elapsedMs: performance.now() - start.startedAt },
    );
    const remaining = complete ? width - swipeOffsetRef.current : swipeOffsetRef.current;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reducedMotion ? 0 : Math.round(Math.min(210, Math.max(110, remaining * 0.55)));

    surface.classList.remove('swipe-tracking');
    surface.classList.add('swipe-settling');
    surface.classList.toggle('swipe-dismissing', complete);
    surface.style.setProperty('--swipe-back-duration', `${duration}ms`);
    setSwipeBackPosition(complete ? width : 0);

    const settle = () => {
      swipeTimerRef.current = null;
      if (complete) onBack();
      else resetSwipeBackSurface();
    };
    if (duration === 0) settle();
    else swipeTimerRef.current = window.setTimeout(settle, duration + 20);
  }

  function cancelSwipeBack() {
    const surface = detailScreenRef.current;
    swipeStartRef.current = null;
    if (!surface || swipeOffsetRef.current === 0) return;
    surface.classList.remove('swipe-tracking', 'swipe-dismissing');
    surface.classList.add('swipe-settling');
    surface.style.setProperty('--swipe-back-duration', '160ms');
    setSwipeBackPosition(0);
    clearSwipeBackTimer();
    swipeTimerRef.current = window.setTimeout(() => {
      swipeTimerRef.current = null;
      resetSwipeBackSurface();
    }, 180);
  }

  function collapseComposer() {
    setComposerExpanded(false);
    messageInputRef.current?.blur();
  }

  useEffect(() => () => {
    clearSwipeBackTimer();
    composerImagesRef.current.forEach((image) => {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    });
  }, [id]);

  useEffect(() => {
    setTaskTraces({});
    optimisticUserMessagesRef.current = [];
    setOptimisticUserMessages([]);
    loadedTraceIdsRef.current = new Set();
  }, [id]);

  const refresh = useCallback(async () => {
    if (localStreamRef.current) return null;
    try {
      const nextConversation = await api.conversation(id);
      setConversation(nextConversation);
      setError('');
      return nextConversation;
    } catch (nextError) {
      setError(nextError.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
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
    if (!conversation || !providers.length || runConfig) return;
    setRunConfig(resolveRunConfig(conversation, providers, agents));
  }, [agents, conversation, providers, runConfig]);

  useEffect(() => {
    const provider = providers.find((item) => item.id === runConfig?.providerId);
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
        const available = nextModels.length ? nextModels : provider.models;
        setModels(available);
        setRunConfig((current) => {
          if (!current || current.providerId !== provider.id || available.some((item) => item.id === current.modelId)) return current;
          const defaultModel = String(payload?.default_model || provider.defaultModelId || available[0]?.id || '');
          return { ...current, modelId: available.some((item) => item.id === defaultModel) ? defaultModel : available[0]?.id || '' };
        });
      })
      .catch(() => {
        if (!cancelled) setModels(provider.models);
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
      const task = await api.task(taskId);
      setTaskTraces((current) => ({ ...current, [taskId]: taskStreamState(task) }));
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
      setLiveRun((current) => current ? { ...current, status: 'cancelled', completedAt: Date.now() } : current);
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
      if (!localStreamRef.current) setLiveRun(null);
      return undefined;
    }

    let cancelled = false;
    async function hydrateActiveTask() {
      if (localStreamRef.current) return;
      try {
        const task = await api.task(taskId);
        if (!cancelled) setLiveRun(taskStreamState(task));
      } catch (nextError) {
        if (!cancelled) setError(nextError.message);
      }
    }

    hydrateActiveTask();
    const timer = window.setInterval(hydrateActiveTask, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTask?.task_id]);

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

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
    if ((!nextMessage && !imageAttachments.length) || !conversation || (running && !activeTaskId) || composerImages.some((image) => image.uploading) || (!running && !runConfig)) return;
    const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const existingOccurrence = optimisticUserMessagesRef.current
      .filter((item) => item.text === nextMessage)
      .reduce((highest, item) => Math.max(highest, item.occurrence), 0);
    const occurrence = Math.max(
      userMessageOccurrenceCount(conversation.messages, nextMessage),
      existingOccurrence,
    ) + 1;
    const optimisticMessage = { id: optimisticId, text: nextMessage, images: imageAttachments, occurrence };
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
      if (running) {
        await api.sendInput(activeTaskId, nextMessage, imageAttachments);
        accepted = true;
        releaseSubmittedImages();
        await refresh();
        return;
      }

      localStreamRef.current = true;
      setLiveRun({
        taskId: null,
        status: 'running',
        text: '',
        createdAt: Date.now(),
        firstTokenAt: 0,
      });
      await api.startTask(
        conversation,
        nextMessage,
        imageAttachments,
        taskOptionsForRunConfig(runConfig, providers),
        (streamEvent) => setLiveRun((current) => applyTaskStreamEvent(current, streamEvent)),
        () => {
          accepted = true;
          releaseSubmittedImages();
          setBusy(false);
        },
      );
      localStreamRef.current = false;
      await refresh();
      setLiveRun(null);
    } catch (nextError) {
      if (!accepted) {
        optimisticUserMessagesRef.current = optimisticUserMessagesRef.current.filter((item) => item.id !== optimisticId);
        setOptimisticUserMessages(optimisticUserMessagesRef.current);
        composerImagesRef.current = submittedComposerImages;
        setComposerImages(submittedComposerImages);
        setMessage(nextMessage);
        if (!running) setLiveRun(null);
      }
      setError(nextError.message);
    } finally {
      localStreamRef.current = false;
      setBusy(false);
    }
  }

  const liveElapsedStart = liveRun?.completedAt ? liveRun.createdAt : liveRun?.firstTokenAt;
  const liveElapsed = liveElapsedStart
    ? formatElapsedDuration(liveElapsedStart, liveRun.completedAt || now)
    : '';
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
  const visibleMessages = (conversation?.messages || []).filter((item) => !(
    running && liveRun && item.role !== 'user' && item.task_id === activeTaskId
  ));
  const visibleOptimisticMessages = optimisticUserMessages.filter((item) => (
    userMessageOccurrenceCount(visibleMessages, item.text) < item.occurrence
  ));

  return (
    <main
      className="detail-screen"
      ref={detailScreenRef}
      onTouchStart={startSwipeBack}
      onTouchMove={moveSwipeBack}
      onTouchEnd={finishSwipeBack}
      onTouchCancel={cancelSwipeBack}
    >
      <div className="detail-top">
        <header className="detail-header">
          <button className="icon-button ghost" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={22} /></button>
          <div><strong>{conversation?.title || 'Task'}</strong><span>{running ? (liveRun?.activity || activeTask?.stage || activeTask?.status || 'Running') : 'Ready to continue'}</span></div>
          <span className="header-spacer" />
        </header>
        {connection || error ? <div className={`detail-error-banner ${reconnecting ? 'connecting' : ''}`} role={reconnecting ? 'status' : 'alert'}>
          {reconnecting ? <RefreshCw className="spin" size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
          <span>{connection?.message || error}</span>
        </div> : null}
      </div>
      <div className="message-region" onClick={collapseComposer}>
        <div className="message-scroll" ref={messageScrollRef}>
          <ApprovalCard approvals={approvals} onResolved={refreshApprovals} />
          {visibleMessages.map((item) => {
            const task = tasksById.get(item.task_id);
            const contentText = textContent(item.content);
            const images = item.role === 'user' ? messageImageRefs(item, task) : [];
            const elapsed = item.role !== 'user' && task?.completed_at
              ? formatElapsedDuration(task.created_at, task.completed_at)
              : '';
            return <article className={`message ${item.role === 'user' ? 'user' : 'assistant'}`} aria-label={item.role === 'user' ? 'Your message' : 'Assistant message'} key={item.message_id || item.id}>
              {images.length ? <div className="message-images" aria-label="Attached images">{images.map((image, index) => (
                <MessageImage conversationId={id} image={image} key={image.image_id || image.path || index} onPreview={setPreviewImage} />
              ))}</div> : null}
              {item.role !== 'user' || contentText ? <div className="message-body">
                {item.role !== 'user' ? <TaskTraceDisclosure state={taskTraces[item.task_id]} elapsed={elapsed} onLoad={() => loadTaskTrace(item.task_id)} /> : null}
                <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{contentText}</ReactMarkdown>
              </div> : null}
            </article>;
          })}
          {visibleOptimisticMessages.map((item) => <article className="message user" aria-label="Your message" key={item.id}>
            {item.images.length ? <div className="message-images" aria-label="Attached images">{item.images.map((image, index) => (
              <MessageImage conversationId={id} image={image} key={image.image_id || image.path || index} onPreview={setPreviewImage} />
            ))}</div> : null}
            {item.text ? <div className="message-body"><ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{item.text}</ReactMarkdown></div> : null}
          </article>)}
          {liveRun && running ? <article className="message assistant" aria-label="Assistant message">
            <div className="message-body streaming">
              <TaskTraceDisclosure state={liveRun} running elapsed={liveElapsed} />
            </div>
          </article> : null}
          {!conversation ? <div className="center-state"><LoaderCircle className="spin" /></div> : null}
        </div>
        <ScrollToBottomButton scrollRef={messageScrollRef} resetKey={id} />
      </div>
      <div className="composer-dock">
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
            onClick={() => photoInputRef.current?.click()}
            aria-label="Choose photos from this device"
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
              {busy ? <span className="send-spinner" aria-hidden="true" /> : <span className="stop-icon" style={{ '--stop-icon': `url(${stopIcon})` }} aria-hidden="true" />}
            </button>
          ) : (
            <button className="send-button" disabled={busy || composerImages.some((image) => image.uploading) || (!message.trim() && !composerImages.some((image) => image.imageId && !image.error)) || (!running && !runConfig)} aria-label={running ? 'Add instruction' : 'Send'}>
              {busy ? <span className="send-spinner" aria-hidden="true" /> : <span className="send-glyph" aria-hidden="true" />}
            </button>
          )}
        </form>
      </div>
      {showRunConfig && runConfig ? <RunConfigSheet config={runConfig} agentLabel={conversation?.profile_display_name} agents={agents} providers={providers} models={models} modelLoading={modelLoading} onChange={setRunConfig} onClose={() => setShowRunConfig(false)} /> : null}
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
  const [fatalError, setFatalError] = useState('');
  const [runtimeOfflineSince, setRuntimeOfflineSince] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [startupRetrying, setStartupRetrying] = useState(true);
  const startupRequestRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const next = await api.status();
    if (api.isNative && !next.paired) await api.forgetConnection();
    setStatus(next);
    setFatalError('');
    return next;
  }, []);

  const loadApprovals = useCallback(async () => {
    try { setApprovals(await api.approvals()); } catch { /* Pairing screen handles auth. */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const projectsResponse = await api.projects();
      const nextProjects = projectsResponse.projects || [];
      const nextConversations = nextProjects.flatMap((project) => project.conversations || []);
      setConversations(nextConversations);
      setProjects(nextProjects);
      const nextTasks = Object.fromEntries(nextConversations.flatMap((item) => item.tasks || []).map((task) => [task.task_id, task]));
      setTasks(nextTasks);
      setFatalError('');
    } catch (error) {
      setFatalError(error.message);
      if (error.status === 401) await loadStatus();
    } finally {
      setLoading(false);
    }
  }, [loadStatus]);

  const connectAtStartup = useCallback(async () => {
    if (startupRequestRef.current) return;
    startupRequestRef.current = true;
    setStartupRetrying(true);
    try {
      const connection = await api.initialize();
      if (api.isNative && !connection) setStatus({ paired: false, runtime_online: false });
      else await loadStatus();
    } catch (error) {
      setFatalError(error.message);
    } finally {
      startupRequestRef.current = false;
      setInitialized(true);
      setStartupRetrying(false);
    }
  }, [loadStatus]);

  useEffect(() => { connectAtStartup(); }, [connectAtStartup]);

  useEffect(() => {
    if (!initialized || status || startupRetrying) return undefined;
    const timer = window.setTimeout(connectAtStartup, 4_000);
    return () => window.clearTimeout(timer);
  }, [connectAtStartup, initialized, startupRetrying, status]);

  useEffect(() => {
    if (status?.runtime_online === false) setRuntimeOfflineSince((current) => current || Date.now());
    else setRuntimeOfflineSince(0);
  }, [status?.runtime_online]);

  useEffect(() => {
    if (!status?.paired) return undefined;
    loadTasks();
    loadApprovals();
    const timer = window.setInterval(() => {
      loadStatus().catch((error) => setFatalError(error.message));
      loadTasks();
      loadApprovals();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status?.paired, loadStatus, loadTasks, loadApprovals]);

  async function createConversation(projectId) {
    const created = await api.createConversation(projectId);
    setSelectedId(created.conversation_id);
    // The detail screen can render immediately; refresh the directory in the background.
    loadTasks();
  }

  function openConversation(conversation) {
    setSelectedId(conversation.conversation_id);
  }

  function closeConversation() {
    setSelectedId(null);
    loadTasks();
  }

  async function logout() {
    try { await api.logout(); } catch { /* Clear the local UI even if already revoked. */ }
    setSelectedId(null);
    setConversations([]);
    setStatus({ paired: false, runtime_online: false });
  }

  if (!initialized || !status) return <ConnectionScreen error={initialized ? fatalError : ''} retrying={startupRetrying} onRetry={connectAtStartup} />;
  if (!status.paired) return <PairingScreen runtimeOnline={status.runtime_online} onPaired={loadStatus} />;
  const connection = runtimeConnectionState(status.runtime_online, runtimeOfflineSince);
  const selectedConversation = conversations.find((item) => item.conversation_id === selectedId) || null;
  if (selectedId) return <ConversationDetail id={selectedId} initialConversation={selectedConversation} onBack={closeConversation} approvals={approvals} refreshApprovals={loadApprovals} connection={connection} />;

  const approvalCount = (approvals?.pending?.length || 0) + (approvals?.pending_workflow_approvals?.length || 0) + (approvals?.pending_user_inputs?.length || 0);
  const reconnecting = connection && !connection.timedOut;

  return (
    <div className="app-shell">
      {connection || fatalError ? <div className={`offline-banner ${reconnecting ? 'connecting' : ''}`} role={reconnecting ? 'status' : 'alert'}>
        {reconnecting ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <span>{connection?.message || fatalError}</span>
      </div> : null}
      {tab === 'tasks' ? (
        <>
          {approvalCount ? <div className="pending-banner"><ShieldCheck size={18} /><span>{approvalCount} {approvalCount === 1 ? 'action' : 'actions'} waiting</span></div> : null}
          <ConversationList projects={projects} conversations={conversations} tasks={tasks} status={status} loading={loading} onOpen={openConversation} onNew={createConversation} onSettings={() => setTab('settings')} />
        </>
      ) : <SettingsScreen status={status} onLogout={logout} onBack={() => setTab('tasks')} />}
    </div>
  );
}
