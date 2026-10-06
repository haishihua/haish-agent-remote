import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Keyboard } from '@capacitor/keyboard';
import { KEYBOARD_FRAME_EVENT, keyboardInset } from './ios-keyboard.js';
import { DesktopSession } from './desktop-session.js';
import './remote-desktop.css';

export default function RemoteDesktop({ onBack }) {
  const video = useRef(null);
  const session = useRef(null);
  const touches = useRef(new Map());
  const gesture = useRef(null);
  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('Enable desktop access on your Mac at http://127.0.0.1:8767. Only unlocked desktops are supported.');
  const [drag, setDrag] = useState(false);
  const [modifiers, setModifiers] = useState([]);
  const [text, setText] = useState('');
  const [zoom, setZoom] = useState(1);
  const [relay, setRelay] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const active = state === 'connected';

  function send(command) { return session.current?.send(command); }
  function stop(note = 'Session ended. Reconnect manually.') {
    clearTimeout(clickTimer.current);
    lastTap.current = 0;
    session.current?.close();
    session.current = null;
    if (video.current) video.current.srcObject = null;
    touches.current.clear();
    setDrag(false); setModifiers([]); setState('idle'); setMessage(note);
  }

  useEffect(() => {
    const hidden = () => { if (document.hidden) stop('App left the foreground. Reconnect manually.'); };
    const left = () => stop();
    const keyboardFrame = (e) => setKeyboardHeight(e.detail?.dismissal ? 0 : keyboardInset(e.detail?.height));
    window.addEventListener(KEYBOARD_FRAME_EVENT, keyboardFrame);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', left);
    // Native container emits this on resigning active / backgrounding.
    const native = (e) => { if (e.detail?.isActive === false) hiddenStop(); };
    const hiddenStop = () => stop('App left the foreground. Reconnect manually.');
    window.addEventListener('haish:app-state', native);
    return () => {
      session.current?.close();
      window.removeEventListener(KEYBOARD_FRAME_EVENT, keyboardFrame);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', left);
      window.removeEventListener('haish:app-state', native);
    };
  }, []);

  async function connect() {
    stop();
    const next = new DesktopSession(api, {
      onState: (s, note = '') => {
        setState(s); setMessage(note);
        if (s !== 'connected') { clearTimeout(clickTimer.current); lastTap.current = 0; setDrag(false); setModifiers([]); touches.current.clear(); }
      },
      onStream: (stream) => {
        if (video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); }
      },
    });
    session.current = next;
    await next.connect(relay);
  }

  function pointerDown(e) {
    if (!active) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 1) gesture.current = { at: Date.now(), x: e.clientX, y: e.clientY, moved: false, multi: false };
    else if (gesture.current) gesture.current.multi = true;
  }
  function pointerMove(e) {
    const previous = touches.current.get(e.pointerId);
    if (!previous || !active) return;
    const dx = e.clientX - previous.x, dy = e.clientY - previous.y;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g && Math.hypot(e.clientX-g.x, e.clientY-g.y) > 5) g.moved = true;
    if (touches.current.size >= 2) send({ type: 'scroll', dx: Math.max(-1000, Math.min(1000, -dx)), dy: Math.max(-1000, Math.min(1000, -dy)) });
    else {
      const bounds = e.currentTarget.getBoundingClientRect();
      send({ type: 'move', dx: Math.max(-1, Math.min(1, dx / bounds.width)), dy: Math.max(-1, Math.min(1, dy / bounds.height)) });
    }
  }
  function pointerUp(e) {
    const g = gesture.current;
    touches.current.delete(e.pointerId);
    if (e.type !== 'pointercancel' && active && g && !g.moved && !g.multi && !drag && Date.now()-g.at < 400) {
      const double = Date.now() - lastTap.current < 300;
      // Delay first click so a double tap emits exactly one double-click.
      clearTimeout(clickTimer.current);
      if (double) { send({ type: 'click', button: 'left', count: 2 }); lastTap.current = 0; }
      else {
        lastTap.current = Date.now();
        clickTimer.current = setTimeout(() => send({ type: 'click', button: 'left', count: 1 }), 300);
      }
    }
    if (e.type === 'pointercancel') { clearTimeout(clickTimer.current); lastTap.current = 0; send({ type: 'release' }); setDrag(false); setModifiers([]); }
    if (!touches.current.size) gesture.current = null;
  }
  const lastTap = useRef(0);
  const clickTimer = useRef(null);
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  function toggleModifier(key) {
    const down = !modifiers.includes(key);
    if (send({ type: 'key', key, down })) setModifiers((old) => down ? [...old, key] : old.filter((k) => k !== key));
  }
  function key(key, modifier) {
    const temporaryModifier = modifier && !modifiers.includes(modifier);
    if (temporaryModifier) send({ type: 'key', key: modifier, down: true });
    send({ type: 'key', key, down: true });
    send({ type: 'key', key, down: false });
    if (temporaryModifier) send({ type: 'key', key: modifier, down: false });
  }

  return <main className="screen-content remote-desktop">
    <header className="screen-header"><button onClick={() => { stop(); onBack(); }}>Back</button><h1>Remote desktop</h1><button onClick={() => stop()} disabled={!session.current}>End</button></header>
    <p role={state === 'failed' ? 'alert' : 'status'}>{state}: {message}</p>
    {!active && state !== 'connecting' && state !== 'reconnecting' ? <div className="desktop-connect"><button onClick={connect}>Connect / retry</button><label><input type="checkbox" checked={relay} onChange={(e) => setRelay(e.target.checked)} />Force TURN (testing)</label></div> : null}
    <div className="desktop-video-viewport"><video ref={video} autoPlay playsInline muted onLoadedData={() => session.current?.frameReceived()} onPlaying={() => session.current?.frameReceived()} style={{ width: `${zoom*100}%`, maxWidth: 'none' }} /></div>
    <label>Zoom <input type="range" min="1" max="3" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
    <div className="desktop-trackpad" role="application" aria-label="Remote trackpad: tap to click, double tap to double-click, two fingers to scroll" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
      Trackpad · tap / double tap · two-finger scroll
    </div>
    <div className="desktop-controls"><button disabled={!active} onClick={() => send({ type: 'click', button: 'right', count: 1 })}>Right click</button><button disabled={!active} aria-pressed={drag} onClick={() => { if (send({ type: 'button', button: 'left', down: !drag })) setDrag(!drag); }}>{drag ? 'Release drag' : 'Begin drag'}</button><button disabled={!active} onClick={() => { send({ type: 'release' }); setModifiers([]); setDrag(false); }}>Release all</button></div>
    <div className="desktop-controls">{['Cmd', 'Ctrl', 'Option', 'Shift'].map((m) => <button key={m} disabled={!active} aria-pressed={modifiers.includes(m)} onClick={() => toggleModifier(m)}>{m}</button>)}{['Esc', 'Tab', 'Enter', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((k) => <button key={k} disabled={!active} onClick={() => key(k)}>{k}</button>)}</div>
    <div className="desktop-controls"><button disabled={!active} onClick={() => key('ArrowLeft', 'Ctrl')}>Space ←</button><button disabled={!active} onClick={() => key('ArrowRight', 'Ctrl')}>Space →</button><button disabled={!active} onClick={() => key('Tab', 'Cmd')}>Cmd + Tab</button></div>
    <form className={`desktop-text${keyboardHeight ? ' keyboard-open' : ''}`} style={{ '--desktop-keyboard-height': `${keyboardHeight}px` }} onSubmit={(e) => { e.preventDefault(); if (send({ type: 'text', text })) setText(''); }}><textarea aria-label="English or Chinese text to type on Mac" maxLength={1024} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type English / 中文, then send" /><button disabled={!active || !text}>Send text</button>{keyboardHeight > 0 ? <button type="button" onClick={() => { document.activeElement?.blur(); Keyboard.hide().catch(() => {}); }}>Hide keyboard</button> : null}</form>
    <small>Keyboard shortcuts follow macOS settings. No audio, clipboard or files. Leaving this page ends control, not your Haish tasks.</small>
  </main>;
}
