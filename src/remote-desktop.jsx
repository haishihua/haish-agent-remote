import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowDownUp, Command, Expand, Hand, Keyboard as KeyboardIcon, Maximize2, Minimize2, Monitor, MoreHorizontal, MousePointer2, Radio, Signal, Square } from 'lucide-react';
import { api } from './api.js';
import { Keyboard } from '@capacitor/keyboard';
import { KEYBOARD_FRAME_EVENT, keyboardInset } from './ios-keyboard.js';
import { DesktopSession } from './desktop-session.js';
import { DesktopGestures } from './desktop-gestures.js';
import { desktopViewSize } from './desktop-view.js';
import DesktopKeyboard from './desktop-keyboard.jsx';
import './remote-desktop.css';

const labels = { idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', failed: 'Connection failed' };
const tabs = [['touchpad', MousePointer2, 'Touchpad'], ['keyboard', KeyboardIcon, 'Keyboard'], ['shortcuts', Command, 'Shortcuts'], ['more', MoreHorizontal, 'More']];

export default function RemoteDesktop({ onBack, computer = 'Computer', onToast }) {
  const video = useRef(null);
  const viewport = useRef(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const session = useRef(null);
  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('');
  const [drag, setDrag] = useState(false);
  const [modifiers, setModifiers] = useState([]);
  const [text, setText] = useState('');
  const [zoom, setZoom] = useState(1.5);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [panel, setPanel] = useState('touchpad');
  const [expanded, setExpanded] = useState(false);
  const [metrics, setMetrics] = useState({});
  const active = state === 'connected';
  const busy = state === 'connecting' || state === 'reconnecting';
  const gestures = useRef(null);
  if (!gestures.current) gestures.current = new DesktopGestures({
    send: (command) => session.current?.send(command),
    onZoom: (ratio) => setZoom((old) => Math.max(1, Math.min(3, old * ratio))),
    onDrag: setDrag,
  });

  function send(command) { return session.current?.send(command); }
  function stop(note = 'Session ended. Reconnect when you’re ready.') {
    gestures.current.reset(true);
    session.current?.close(); session.current = null;
    if (video.current) video.current.srcObject = null;
    setModifiers([]); setState('idle'); setMessage(note); setMetrics({});
  }

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const left = () => stop('App left the foreground. Reconnect manually.');
    const hidden = () => { if (document.hidden) left(); };
    const native = (e) => { if (e.detail?.isActive === false) left(); };
    const keyboardFrame = (e) => setKeyboardHeight(e.detail?.dismissal ? 0 : keyboardInset(e.detail?.height));
    window.addEventListener(KEYBOARD_FRAME_EVENT, keyboardFrame);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', left);
    window.addEventListener('haish:app-state', native);
    return () => {
      gestures.current.reset(true); session.current?.close();
      window.removeEventListener(KEYBOARD_FRAME_EVENT, keyboardFrame);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', left);
      window.removeEventListener('haish:app-state', native);
    };
  }, []);

  async function connect() {
    stop(); setZoom(1.5);
    const next = new DesktopSession(api, {
      onState: (s, note = '') => {
        if (session.current !== next) return;
        setState(s); setMessage(note);
        if (s !== 'connected') { gestures.current.reset(); setModifiers([]); }
      },
      onStream: (stream) => {
        if (session.current === next && video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); }
      },
      onMetrics: (update) => { if (session.current === next) setMetrics((old) => ({ ...old, ...update })); },
    });
    session.current = next;
    await next.connect();
  }
  function changePanel(next) {
    gestures.current.reset(true); setModifiers([]);
    document.activeElement?.blur(); Keyboard.hide().catch(() => {});
    setPanel(next);
  }
  function toggleModifier(key) {
    const down = !modifiers.includes(key);
    if (send({ type: 'key', key, down })) setModifiers((old) => down ? [...old, key] : old.filter((k) => k !== key));
  }
  function key(key, modifier) {
    const temporary = modifier && !modifiers.includes(modifier);
    if (temporary) send({ type: 'key', key: modifier, down: true });
    send({ type: 'key', key, down: true }); send({ type: 'key', key, down: false });
    if (temporary) send({ type: 'key', key: modifier, down: false });
  }
  const viewSize = desktopViewSize(viewportSize.width, viewportSize.height, metrics.width, metrics.height, zoom);
  const resolution = metrics.width && metrics.height ? `${metrics.width} × ${metrics.height}` : 'Waiting for video';

  return <main className={`remote-desktop${expanded ? ' is-expanded' : ''}`}>
    <header className="desktop-header">
      <button className="desktop-back" onClick={() => { stop(); onBack(); }}><ArrowLeft size={18} /><span>Back</span></button>
      <div><h1>Remote Desktop</h1><p className={active ? 'is-online' : ''} role="status"><i />{labels[state]}<span> · {computer}</span></p></div>
      <button className="desktop-end" onClick={() => stop()} disabled={!active && !busy}><Square size={12} fill="currentColor" />End</button>
    </header>

    <section className="desktop-video-card" aria-label="Live remote desktop">
      <div ref={viewport} className="desktop-video-viewport"><div className="desktop-video-surface"><video style={{ width: viewSize.width || '100%', height: viewSize.height || '100%' }} ref={video} autoPlay playsInline muted onLoadedData={() => session.current?.frameReceived()} onPlaying={() => session.current?.frameReceived()} onResize={() => {
        if (video.current?.videoWidth) setMetrics((old) => ({ ...old, width: video.current.videoWidth, height: video.current.videoHeight }));
      }} /></div></div>
      <div className="desktop-video-hud"><span className="desktop-hud-pill"><Monitor size={15} />{resolution}</span><div><span className={`desktop-hud-pill desktop-latency${active ? ' is-online' : ''}`} title="Round-trip latency, not input-to-frame latency"><Signal size={16} />{active && Number.isFinite(metrics.rttMs) ? `${Math.round(metrics.rttMs)}ms` : '—'}</span><button onClick={() => setZoom(zoom === 1 ? 1.5 : 1)} aria-label="Toggle video zoom" title="1× shows the entire desktop; 1.5× enlarges it and allows panning">{zoom.toFixed(1)}×</button><button onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Exit expanded view' : 'Expand desktop view'}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></div></div>
      {!active ? <div className="desktop-video-empty"><Monitor size={38} strokeWidth={1.3} /><h2>{busy ? labels[state] : 'Your desktop, anywhere'}</h2><p>{busy ? 'Establishing a secure WebRTC connection' : 'Connect to see and control your Mac’s live screen.'}</p>{!busy ? <button className="desktop-primary" onClick={connect}>{state === 'failed' ? 'Try again' : 'Connect to computer'}</button> : <span className="desktop-connecting-dot" />}</div> : null}
    </section>
    {message ? <p className={`desktop-session-note${state === 'failed' ? ' is-error' : ''}`} role={state === 'failed' ? 'alert' : 'status'}>{message}</p> : null}

    <nav className="desktop-toolbar" aria-label="Remote controls">{tabs.map(([id, Icon, label]) => <button key={id} aria-label={label} className={panel === id ? 'is-selected' : ''} aria-pressed={panel === id} onClick={() => changePanel(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>

    {panel === 'touchpad' ? <section className={`desktop-trackpad${drag ? ' is-dragging' : ''}${!active ? ' is-disabled' : ''}`} role="application" aria-disabled={!active} aria-label="Remote trackpad: tap to click, double tap to double-click, two fingers to scroll, pinch to zoom, long press to drag" onContextMenu={(e) => e.preventDefault()} onPointerDown={(e) => {
      if (!active) return; e.currentTarget.setPointerCapture(e.pointerId); gestures.current.down(e.pointerId, e.clientX, e.clientY);
    }} onPointerMove={(e) => { if (active) { const b = e.currentTarget.getBoundingClientRect(); gestures.current.move(e.pointerId, e.clientX, e.clientY, b.width, b.height); } }} onPointerUp={(e) => gestures.current.up(e.pointerId)} onPointerCancel={(e) => gestures.current.up(e.pointerId, true)} onLostPointerCapture={(e) => gestures.current.up(e.pointerId, true)}>
      <MousePointer2 className="desktop-trackpad-cursor" size={29} strokeWidth={1.4} /><h2>{drag ? 'Dragging · lift to release' : 'Use gestures to control'}</h2><p>{active ? 'Just like a Mac trackpad' : 'Connect to activate the trackpad'}</p>
      <div className="desktop-gesture-hints">{[[Hand, 'One finger', 'Move & tap'], [ArrowDownUp, 'Two fingers', 'Scroll'], [Expand, 'Pinch', 'Zoom view'], [Hand, 'Long press', 'Then drag']].map(([Icon, title, hint]) => <div key={title}><Icon size={28} strokeWidth={1.3} /><strong>{title}</strong><span>{hint}</span></div>)}</div>
    </section> : null}
    {panel === 'touchpad' ? <div className="desktop-trackpad-actions" aria-label="Trackpad buttons and modifiers"><button disabled={!active} onClick={() => send({ type: 'click', button: 'right', count: 1 })}>Right click</button>{['Cmd', 'Shift'].map((m) => <button key={m} disabled={!active} aria-pressed={modifiers.includes(m)} onClick={() => toggleModifier(m)}>{m}</button>)}<button disabled={!active} onClick={() => { gestures.current.reset(true); setModifiers([]); }}>Release all</button></div> : null}

    {panel === 'keyboard' ? <DesktopKeyboard active={active} keyboardHeight={keyboardHeight} text={text} setText={setText} send={send} onKey={key} onToast={onToast} /> : null}

    {panel === 'shortcuts' ? <section className="desktop-panel"><h2><Command size={20} />Keyboard shortcuts</h2><p>Modifiers stay held until toggled or released.</p><div className="desktop-controls">{['Cmd', 'Ctrl', 'Option', 'Shift'].map((m) => <button key={m} disabled={!active} aria-pressed={modifiers.includes(m)} onClick={() => toggleModifier(m)}>{m}</button>)}</div><div className="desktop-controls">{[['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight']].map(([label, k]) => <button key={k} aria-label={k} disabled={!active} onClick={() => key(k)}>{label}</button>)}</div><div className="desktop-controls"><button disabled={!active} onClick={() => key('ArrowLeft', 'Ctrl')}>Space ←</button><button disabled={!active} onClick={() => key('ArrowRight', 'Ctrl')}>Space →</button><button disabled={!active} onClick={() => key('Tab', 'Cmd')}>⌘ Tab</button></div><button className="desktop-release" disabled={!active} onClick={() => { gestures.current.reset(true); setModifiers([]); }}>Release all keys & buttons</button></section> : null}

    {panel === 'more' ? <section className="desktop-panel"><h2><MoreHorizontal size={20} />Session options</h2><div className="desktop-controls"><button disabled={!active} onClick={() => send({ type: 'click', button: 'right', count: 1 })}>Right click</button><button disabled={!active} onClick={() => { gestures.current.reset(true); setModifiers([]); }}>Release all</button></div><label className="desktop-zoom">View zoom <span>{zoom.toFixed(1)}×</span><input aria-label="View zoom" type="range" min="1" max="3" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label><p>Zoomed video can be panned independently of the trackpad.</p><p>Connection routing is automatic: direct when possible, with TURN relay as a fallback when configured on your Mac.</p><p>Enable desktop access locally at <span className="desktop-local-address">http://127.0.0.1:8767</span>. Grant Screen Recording and Accessibility; keep your Mac unlocked.</p><p>Audio, microphone, clipboard and file transfer are not supported.</p></section> : null}

    <footer className="desktop-computer-bar"><div className="desktop-computer-icon"><Monitor size={23} /></div><div className="desktop-computer-copy"><strong>{computer}</strong><span>{active ? `${metrics.connectionType === 'relay' ? 'TURN relay' : metrics.connectionType === 'direct' ? 'Direct WebRTC' : 'WebRTC'}${Number.isFinite(metrics.fps) ? ` · ${Math.round(metrics.fps)} fps` : ''}` : 'Secure remote access'}</span></div><button className="desktop-footer-options" aria-label="Session options" onClick={() => changePanel(panel === 'more' ? 'touchpad' : 'more')}><MoreHorizontal size={22} /></button></footer>
    <p className="desktop-footnote"><Radio size={12} />Leaving this page ends control, not your Haish tasks.</p>
  </main>;
}
