import { Keyboard } from '@capacitor/keyboard';

import { isNativeApp } from './native-connection.js';

/** Hide WKWebView's system form accessory row (previous/next/done). */
export async function hideKeyboardAccessoryBar({ keyboard = Keyboard, native = isNativeApp } = {}) {
  if (!native) return false;
  await keyboard.setAccessoryBarVisible({ isVisible: false });
  return true;
}

/** Direct event emitted by HaishBridgeViewController for every UIKit keyboard frame transition. */
export const KEYBOARD_FRAME_EVENT = 'haishKeyboardFrame';
export const KEYBOARD_MOTION_MS = 250;
export const KEYBOARD_MOTION_MS_RANGE = [100, 600];
export const KEYBOARD_MOTION_EASING = 'cubic-bezier(0.3, 0.35, 0.15, 1)';
export const KEYBOARD_COMPOSER_EXPANDED_CLASS = 'expanded';

export function keyboardInset(value) {
  const height = Number(value);
  return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

export function keyboardLift({ keyboardHeight = 0, lift = null } = {}) {
  if (lift !== null && lift !== undefined && lift !== '') {
    const reported = Number(lift);
    if (Number.isFinite(reported)) return Math.max(0, Math.round(reported));
  }
  return keyboardInset(keyboardHeight);
}

export function keyboardMotionMs(seconds, fallback = KEYBOARD_MOTION_MS) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const [min, max] = KEYBOARD_MOTION_MS_RANGE;
  return Math.min(max, Math.max(min, Math.round(value * 1000)));
}

/** Remaining UIKit animation time when the native event reaches the Web process. */
export function keyboardRemainingMs({ at = null, now = Date.now(), duration = KEYBOARD_MOTION_MS } = {}) {
  const started = at === null || at === undefined || at === '' ? Number.NaN : Number(at);
  const current = Number(now);
  const span = Number(duration);
  if (!Number.isFinite(started) || !Number.isFinite(current) || !Number.isFinite(span) || span <= 0) return Math.max(0, Math.round(span) || 0);
  return Math.max(0, Math.round(span - Math.max(0, current - started)));
}

let keyboardSurface = null;
let movingControllers = 0;

export function isKeyboardMoving() {
  return movingControllers > 0;
}

/** The open conversation hands over only the small dock and its scroll viewport. */
export function registerKeyboardSurface(next) {
  keyboardSurface = next;
  return () => {
    if (keyboardSurface === next) keyboardSurface = null;
  };
}

export function createKeyboardInsetController({
  native = isNativeApp,
  getSurface = () => keyboardSurface,
  viewport = typeof window === 'undefined' ? null : window,
  readClock = () => Date.now(),
  scheduleTimer = (callback, ms) => setTimeout(callback, ms),
  unscheduleTimer = (timer) => clearTimeout(timer),
  easing = KEYBOARD_MOTION_EASING,
  setComposerExpanded = (dock, expanded) => dock?.querySelector?.('.composer')?.classList?.toggle(KEYBOARD_COMPOSER_EXPANDED_CLASS, expanded),
} = {}) {
  let stopped = false;
  let lift = 0;
  let inset = 0;
  let timer = 0;
  let dockAnimation = null;
  let moving = false;

  function setMoving(active) {
    if (moving === active) return;
    moving = active;
    movingControllers += active ? 1 : -1;
  }

  function clearMotionTimer() {
    if (timer) unscheduleTimer(timer);
    timer = 0;
    setMoving(false);
  }

  function markMoving(ms) {
    clearMotionTimer();
    if (ms <= 0) return;
    setMoving(true);
    timer = scheduleTimer(() => {
      timer = 0;
      setMoving(false);
    }, ms);
  }

  function pieces() {
    const surface = getSurface?.();
    return { dock: surface?.dockRef?.current || null };
  }

  function applyFrame(event) {
    const detail = event?.detail || {};
    const dismissal = Boolean(detail.dismissal);
    const nextInset = dismissal ? 0 : keyboardInset(detail.height);
    if (!dismissal && !nextInset) return;
    const nextLift = dismissal ? 0 : keyboardLift({ keyboardHeight: nextInset, lift: detail.lift });
    const fromLift = detail.fromLift === null || detail.fromLift === undefined || detail.fromLift === ''
      ? lift
      : keyboardLift({ keyboardHeight: inset, lift: detail.fromLift });
    const duration = keyboardMotionMs(detail.duration);
    const remaining = keyboardRemainingMs({ at: detail.at, now: readClock(), duration });
    const { dock } = pieces();

    if (dismissal) setComposerExpanded(dock, false);

    // Only the small composer layer moves. The negative delay places its first painted frame at the
    // point UIKit has already reached; unlike shortening a CSS transition, it never paints from the
    // stale baseline after the keyboard is visible. There are no computed-style or geometry reads.
    if (dock && nextLift !== lift) {
      const elapsed = Math.max(0, duration - remaining);
      const nextAnimation = dock.animate([
        { transform: `translate3d(0, ${-fromLift}px, 0)` },
        { transform: `translate3d(0, ${-nextLift}px, 0)` },
      ], {
        duration,
        delay: elapsed ? -elapsed : 0,
        easing,
        fill: 'both',
      });
      const previous = dockAnimation;
      dockAnimation = nextAnimation;
      previous?.cancel?.();
    }

    // Never mutate the long message scroller from a keyboard callback. Its fixed reserve already
    // keeps the latest row clear of the composer; changing padding here invalidated every skipped
    // content-visibility row and woke Mutation/Resize observers during IME work.
    inset = nextInset;
    lift = nextLift;
    markMoving(remaining);
  }

  function start() {
    if (stopped || !native) return stop;
    viewport?.addEventListener?.(KEYBOARD_FRAME_EVENT, applyFrame);
    return stop;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    viewport?.removeEventListener?.(KEYBOARD_FRAME_EVENT, applyFrame);
    clearMotionTimer();
    const { dock } = pieces();
    dockAnimation?.cancel?.();
    dockAnimation = null;
    if (dock) dock.style.transform = 'translate3d(0, 0, 0)';
    inset = 0;
    lift = 0;
  }

  return { start, stop, applyFrame, state: () => ({ inset, lift, moving }) };
}

export function mountKeyboardInset(options = {}) {
  const controller = createKeyboardInsetController(options);
  controller.start();
  return () => controller.stop();
}
