// UI-only gesture recognition. Control authorization remains in DesktopSession.
export class DesktopGestures {
  constructor({ send, onZoom, onDrag, now = () => Date.now(), schedule = (callback, delay) => globalThis.setTimeout(callback, delay), cancel = (timer) => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { send, onZoom, onDrag, now, schedule, cancel });
    this.points = new Map();
    this.lastTap = null;
  }
  down(id, x, y) {
    this.points.set(id, { x, y });
    if (this.points.size === 1) {
      this.gesture = { at: this.now(), x, y, moved: false, multi: false };
      this.hold = this.schedule(() => {
        if (this.points.size === 1 && this.gesture && !this.gesture.moved && !this.gesture.multi) {
          this.dragging = Boolean(this.send({ type: 'button', button: 'left', down: true }));
          this.onDrag?.(this.dragging);
        }
      }, 450);
    } else {
      this.cancel(this.hold);
      this.gesture.multi = true;
      // A pending tap must not turn into a click during/after a multi gesture.
      this.cancel(this.click);
      this.lastTap = null;
      if (this.dragging) this.releaseDrag();
      this.multiStart = this.points.size === 2 ? [...this.points.values()] : null;
      this.mode = null;
    }
  }
  move(id, x, y, width, height) {
    const prev = this.points.get(id);
    if (!prev || !this.gesture) return;
    const before = [...this.points.values()];
    this.points.set(id, { x, y });
    const g = this.gesture;
    if (Math.hypot(x - g.x, y - g.y) > 5) { g.moved = true; this.cancel(this.hold); }
    const clamp = (n, bound) => Math.max(-bound, Math.min(bound, n));
    if (this.points.size === 2) {
      const after = [...this.points.values()];
      const distance = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const center = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
      let baseline = before;
      if (!this.mode) {
        // Pointer events arrive one finger at a time. Comparing only the latest
        // event can mistake the first half of a parallel scroll for a pinch.
        const start = this.multiStart;
        const motion = after.map((p, i) => ({ x: p.x - start[i].x, y: p.y - start[i].y }));
        const lengths = motion.map((p) => Math.hypot(p.x, p.y));
        if (lengths.some((length) => length <= 5)) return;
        const travel = Math.hypot(center(after).x - center(start).x, center(after).y - center(start).y);
        const spread = Math.abs(distance(after) - distance(start));
        const alignment = (motion[0].x * motion[1].x + motion[0].y * motion[1].y) / (lengths[0] * lengths[1]);
        // Aligned motion is scrolling even when one finger's event stream leads
        // the other's; divergent motion with dominant separation is pinching.
        if (alignment < 0.7 && spread > 9 && spread > travel * 1.4) this.mode = 'pinch';
        else if (travel > 5) this.mode = 'scroll';
        baseline = start;
      }
      if (this.mode === 'pinch' && distance(baseline) > 0) this.onZoom?.(distance(after) / distance(baseline));
      else if (this.mode === 'scroll') this.send({ type: 'scroll', dx: clamp(center(baseline).x - center(after).x, 1000), dy: clamp(center(baseline).y - center(after).y, 1000) });
    } else if (this.points.size === 1 && !g.multi) {
      this.send({ type: 'move', dx: clamp((x - prev.x) / Math.max(width, 1), 1), dy: clamp((y - prev.y) / Math.max(height, 1), 1) });
    }
  }
  up(id, cancelled = false) {
    const g = this.gesture;
    if (!this.points.has(id)) return;
    this.points.delete(id);
    this.cancel(this.hold);
    if (cancelled) { this.reset(true); return; }
    // Rebase when the contact set changes (including a third finger lifting).
    this.multiStart = this.points.size === 2 ? [...this.points.values()] : null;
    this.mode = null;
    if (!this.points.size) {
      if (this.dragging) this.releaseDrag();
      else if (g && !g.moved && !g.multi && this.now() - g.at < 400) {
        const double = this.lastTap !== null && this.now() - this.lastTap < 300;
        this.cancel(this.click);
        if (double) { this.send({ type: 'click', button: 'left', count: 2 }); this.lastTap = null; }
        else { this.lastTap = this.now(); this.click = this.schedule(() => { this.send({ type: 'click', button: 'left', count: 1 }); this.lastTap = null; }, 300); }
      }
      this.gesture = null;
    }
  }
  releaseDrag() {
    this.send({ type: 'button', button: 'left', down: false });
    this.dragging = false;
    this.onDrag?.(false);
  }
  reset(release = false) {
    this.cancel(this.hold); this.cancel(this.click);
    if (release) this.send({ type: 'release' });
    this.points.clear(); this.gesture = null; this.lastTap = null; this.dragging = false;
    this.multiStart = null; this.mode = null;
    this.onDrag?.(false);
  }
}
