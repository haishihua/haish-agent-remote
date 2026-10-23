import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Delete, Keyboard as KeyboardIcon, Send, X } from 'lucide-react';
import { Keyboard } from '@capacitor/keyboard';

// 键盘只负责发字；发没发出去的反馈走轻提示（见 toast.jsx），不占面板里那一行常驻文字。
const NOOP_TOAST = () => {};

export default function DesktopKeyboard({ active, keyboardHeight, text, setText, send, onKey, onToast }) {
  const pushToast = onToast || NOOP_TOAST;
  const input = useRef(null);
  const composing = useRef(false);
  const [isComposing, setComposing] = useState(false);
  useEffect(() => {
    if (active) input.current?.focus({ preventScroll: true });
    return () => { input.current?.blur(); };
  }, [active]);

  function submit(event) {
    event.preventDefault();
    // Enter commits Chinese IME; it must never submit an unfinished composition.
    if (!active || composing.current || !text) return;
    if (send({ type: 'text', text })) {
      setText('');
      pushToast('success', 'Sent to computer');
      input.current?.focus({ preventScroll: true });
    } else {
      pushToast('error', 'Not sent · draft kept');
    }
  }
  function hide() { input.current?.blur(); Keyboard.hide().catch(() => {}); }
  function focusInput() { input.current?.focus({ preventScroll: true }); }
  const keys = [['Esc', 'Esc'], ['Tab', 'Tab'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['⌫', 'Backspace'], ['↵', 'Enter']];
  return <section className="desktop-panel desktop-keyboard-panel" aria-label="Remote keyboard">
    <div className="desktop-keyboard-heading"><h2><KeyboardIcon size={18} />Keyboard</h2><span>{active ? '中文 / English' : 'Connect before typing'}</span>{active && !keyboardHeight ? <button type="button" onClick={focusInput} aria-label="Open phone keyboard"><KeyboardIcon size={16} /></button> : null}</div>
    <form className={`desktop-text${keyboardHeight ? ' keyboard-open' : ''}`} style={{ '--desktop-keyboard-height': `${keyboardHeight}px` }} onSubmit={submit}>
      <div className="desktop-keyboard-caption"><span>{active ? 'Draft · tap Send to type on Mac' : 'Keyboard available after connection'}</span>{keyboardHeight > 0 ? <button type="button" aria-label="Hide keyboard" onClick={hide}><X size={18} /></button> : null}</div>
      <textarea ref={input} disabled={!active} aria-label="English or Chinese text to type on Mac" maxLength={1024} rows={2} value={text} onChange={(e) => { setText(e.target.value); }} onCompositionStart={() => { composing.current = true; setComposing(true); }} onCompositionEnd={() => { composing.current = false; setComposing(false); }} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) submit(e);
      }} placeholder="输入中文或英文…" />
      <div className="desktop-keyboard-submit"><span role="status">{`${text.length}/1024 · ↵ inserts a line`}</span><button type="submit" className="desktop-primary" disabled={!active || !text || isComposing}><Send size={16} />Send text</button></div>
      <div className="desktop-keyboard-keys" aria-label="Remote keyboard keys">{keys.map(([label, key]) => <button key={key} type="button" aria-label={key} disabled={!active || isComposing} onPointerDown={(e) => e.preventDefault()} onClick={() => onKey(key)}>{key === 'Backspace' ? <Delete size={17} /> : key === 'Enter' ? <CornerDownLeft size={17} /> : label}</button>)}</div>
    </form>
  </section>;
}
