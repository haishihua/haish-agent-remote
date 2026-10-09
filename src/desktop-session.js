// No input queues: commands are accepted only under the server's current lease.
export class DesktopSession {
  constructor(api, { onState, onStream, onMetrics, Peer = globalThis.RTCPeerConnection, now = () => globalThis.performance.now() } = {}) {
    Object.assign(this, { api, onState, onStream, onMetrics, Peer, now });
    this.closed = false;
    this.epoch = null;
    this.seq = 0;
    this.lastReady = 0;
    this.quality = 'high';
    this.generation = 0;
    this.probeSeq = 0;
    this.probes = new Map();
    this.ticket = null;
    this.inputUntil = 0;
    this.paused = true;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
  }

  async connect(relay = false) {
    try {
      this.onState?.('connecting');
      const config = await this.api.desktopIce();
      if (this.closed) return;
      this.turnConfigured = config.turn_configured;
      if (relay && !config.turn_configured) throw new Error('TURN is not configured; only direct connections can be attempted.');
      const pc = this.pc = new this.Peer({ iceServers: config.iceServers, iceTransportPolicy: relay ? 'relay' : 'all' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      const dc = this.dc = pc.createDataChannel('input', { ordered: true, maxPacketLifeTime: 250 });
      dc.onopen = () => this.ping();
      dc.onmessage = (event) => this.response(event.data);
      dc.onclose = () => this.disconnected();
      pc.ontrack = (event) => this.onStream?.(event.streams[0] || new MediaStream([event.track]));
      pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed'].includes(pc.connectionState)) this.disconnected();
        if (pc.connectionState === 'connected') this.ping();
      };
      const offer = await pc.createOffer();
      if (this.closed) return;
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 10_000);
      if (this.closed) return;
      const answer = await this.api.desktopOffer({ sdp: pc.localDescription.sdp, type: 'offer' });
      // If the page left while HTTP negotiation was in flight, clean up the
      // resulting server lease, not just the now-closed local peer.
      this.id = answer.session_id;
      if (this.closed) { await this.api.desktopEnd(this.id).catch(() => {}); return; }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      if (this.closed) return;
      this.startedAt = this.now();
      this.timer = setInterval(() => this.tick(), 500);
      this.statsTimer = setInterval(() => this.adapt(), 3000);
      this.statusTimer = setInterval(() => this.checkAuthorization(), 2000);
    } catch (error) {
      if (!this.closed) this.onState?.('failed', error.message);
      this.close();
    }
  }

  ping() {
    if (this.closed || this.dc?.readyState !== 'open' || this.dc.bufferedAmount !== 0) return;
    const now = this.now();
    for (const [id, probe] of this.probes) if (now - probe.at >= 750) this.probes.delete(id);
    const probe = `${this.generation}:${++this.probeSeq}`;
    this.probes.set(probe, { at: now, generation: this.generation });
    this.dc.send(JSON.stringify({ type: 'ping', generation: this.generation, probe,
      paused: this.paused, quality: this.quality, heldKeys: [...this.heldKeys], heldButtons: [...this.heldButtons] }));
  }

  response(raw) {
    if (this.closed) return;
    try {
      const data = JSON.parse(raw);
      const probe = this.probes.get(data.probe);
      const now = this.now();
      if (!probe || probe.generation !== this.generation || data.generation !== this.generation ||
          now - probe.at >= 750 || typeof data.epoch !== 'string' || typeof data.ticket !== 'string' ||
          !Number.isFinite(data.validForMs) || data.validForMs <= 0) return;
      // Late replies cannot postpone pause. Starting another generation clears
      // pending probes, so a buffered ready/challenge cannot resume old control.
      if (!this.paused && now >= this.inputUntil) {
        this.disconnected(); this.ping(); return;
      }
      if (data.type === 'challenge') {
        if (!this.paused) { this.disconnected(); this.ping(); return; }
        if (probe.resume || this.dc?.readyState !== 'open' || this.dc.bufferedAmount !== 0) return;
        probe.resume = { epoch: data.epoch, ticket: data.ticket };
        this.dc.send(JSON.stringify({ type: 'resume', generation: this.generation, probe: data.probe,
          epoch: data.epoch, ticket: data.ticket }));
        return;
      }
      if (data.type !== 'ready' || (this.paused && (!probe.resume ||
          probe.resume.epoch !== data.epoch || probe.resume.ticket !== data.ticket)) ||
          (!this.paused && data.epoch !== this.epoch)) return;
      this.probes.delete(data.probe);
      const until = Math.min(probe.at + 750, now + Math.min(data.validForMs, 750));
      if (until <= now || until <= this.inputUntil) return;
      this.ticket = data.ticket;
      this.epoch = data.epoch;
      this.inputUntil = until;
      this.lastReady = now;
      this.paused = false;
      this.offlineSince = null;
      // A working connection needs no missing-fallback warning.
      this.onState?.('connected', '');
      const rttMs = now - probe.at;
      if (Number.isFinite(rttMs) && rttMs >= 0) this.emitMetrics({ rttMs });
    } catch { /* Unrecognized control responses never enable input. */ }
  }

  send(command) {
    // An unsent up is still a local release intent: the next fresh heartbeat
    // reconciles it, so backpressure cannot latch a shortcut's modifier forever.
    if (command.type === 'key' && !command.down) this.heldKeys.delete(command.key);
    if (command.type === 'button' && !command.down) this.heldButtons.delete(command.button);
    if (command.type === 'release') { this.heldKeys.clear(); this.heldButtons.clear(); }
    if (this.closed || this.paused || !this.epoch || !this.ticket || this.now() >= this.inputUntil || this.dc?.readyState !== 'open' || this.dc.bufferedAmount > 8192 || this.pc?.connectionState !== 'connected') return false;
    this.dc.send(JSON.stringify({ ...command, generation: this.generation,
      epoch: this.epoch, ticket: this.ticket, seq: ++this.seq }));
    if (command.type === 'key') command.down ? this.heldKeys.add(command.key) : this.heldKeys.delete(command.key);
    if (command.type === 'button') command.down ? this.heldButtons.add(command.button) : this.heldButtons.delete(command.button);
    if (command.type === 'release') { this.heldKeys.clear(); this.heldButtons.clear(); }
    return true;
  }

  disconnected() {
    if (this.closed) return;
    if (this.offlineSince != null) return;
    this.send({ type: 'release' });
    this.paused = true;
    ++this.generation;
    this.probes.clear();
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.epoch = this.ticket = null;
    this.inputUntil = 0;
    this.offlineSince = this.now();
    this.onState?.('reconnecting', 'Input paused. Retrying for at most 30 seconds; old commands will not be replayed.');
  }

  tick() {
    if (this.closed) return;
    if (!this.paused && this.now() >= this.inputUntil) this.disconnected();
    if ((!this.lastReady || !this.firstFrame) && this.now() - this.startedAt > 10_000) {
      this.onState?.('failed', this.turnConfigured
        ? 'Unable to connect to the desktop. Check the network and retry; automatic relay was available.'
        : 'Unable to connect directly. Check the network and retry. This computer has no TURN fallback configured.');
      this.close(); return;
    }
    if (this.offlineSince != null && this.now() - this.offlineSince >= 30_000) {
      this.onState?.('failed', 'Reconnection timed out. Reconnect manually.');
      this.close(); return;
    }
    this.ping();
  }

  frameReceived() { this.firstFrame = true; }

  async checkAuthorization() {
    if (this.closed || this.checkingStatus) return;
    this.checkingStatus = true;
    try {
      const status = await this.api.desktopStatus();
      if (this.closed) return;
      const reasons = {
        enabled: 'Desktop access was disabled on the computer.',
        supported: 'Desktop capture is unavailable on this computer.',
        screen_recording: 'Screen Recording permission was lost. Check System Settings on the Mac.',
        accessibility: 'Accessibility permission was lost. Check System Settings on the Mac.',
        unlocked: 'Mac locked or left its logged-in desktop. Unlock locally and reconnect.',
      };
      for (const [field, reason] of Object.entries(reasons)) {
        if (status[field] === false) { this.onState?.('failed', reason); this.close(); break; }
      }
    } catch (error) {
      if (!this.closed && error.status === 401) { this.onState?.('failed', 'Pairing was revoked. Pair again before reconnecting.'); this.close(); }
      // Offline status alone cannot authorize input; the data-channel lease expires.
    } finally { this.checkingStatus = false; }
  }

  // Partial measured updates only: width/height in pixels, fps, heartbeat rttMs,
  // and connectionType ('direct' or 'relay'). Never expose raw ICE reports.
  emitMetrics(metrics) {
    if (this.closed || !Object.keys(metrics).length) return;
    try { this.onMetrics?.(metrics); } catch { /* Observers cannot affect control or adaptation. */ }
  }

  async adapt() {
    const pc = this.pc;
    if (this.closed || !pc?.getStats || this.checkingStats) return;
    this.checkingStats = true;
    try {
      const stats = await pc.getStats();
      if (this.closed || this.pc !== pc) return;
      const metrics = {};
      for (const report of stats.values()) {
        if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video') {
          if (Number.isFinite(report.frameWidth) && report.frameWidth > 0) metrics.width = report.frameWidth;
          if (Number.isFinite(report.frameHeight) && report.frameHeight > 0) metrics.height = report.frameHeight;
          if (Number.isFinite(report.framesPerSecond) && report.framesPerSecond >= 0) metrics.fps = report.framesPerSecond;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const old = this.lastStats;
          if (old) {
            const received = report.packetsReceived - old.received;
            const lost = report.packetsLost - old.lost;
            this.quality = lost > Math.max(1, received * .03) ? 'low' : 'high';
          }
          this.lastStats = { received: report.packetsReceived, lost: report.packetsLost };
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime > .2) this.quality = 'low';
      }
      // Prefer the transport's actual selected pair, not an arbitrary successful
      // connectivity check. Older implementations may mark the pair selected.
      const reports = [...stats.values()];
      const transport = reports.find((report) => report.type === 'transport' && report.selectedCandidatePairId);
      let pair = transport ? stats.get(transport.selectedCandidatePairId) :
        reports.find((report) => report.type === 'candidate-pair' && report.selected === true);
      if (!pair && !transport) {
        const nominated = reports.filter((report) => report.type === 'candidate-pair' && report.nominated === true && report.state === 'succeeded');
        if (nominated.length === 1) pair = nominated[0];
      }
      if (pair?.type === 'candidate-pair') {
        const local = stats.get(pair.localCandidateId)?.candidateType;
        const remote = stats.get(pair.remoteCandidateId)?.candidateType;
        const directTypes = ['host', 'srflx', 'prflx'];
        if (local === 'relay' || remote === 'relay') metrics.connectionType = 'relay';
        else if (directTypes.includes(local) && directTypes.includes(remote)) metrics.connectionType = 'direct';
      }
      this.emitMetrics(metrics);
    } catch { /* Stats are best-effort, never a reason to send stale input. */ }
    finally { this.checkingStats = false; }
  }

  close() {
    if (this.closed) return;
    this.send({ type: 'release' });
    this.closed = true;
    this.epoch = this.ticket = null;
    this.paused = true;
    this.probes.clear();
    this.heldKeys.clear();
    this.heldButtons.clear();
    clearInterval(this.timer);
    clearInterval(this.statsTimer);
    clearInterval(this.statusTimer);
    this.dc?.close();
    this.pc?.close();
    if (this.id) this.api.desktopEnd(this.id).catch(() => {});
  }
}

export function waitForIce(pc, timeout) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', changed);
      error ? reject(error) : resolve();
    };
    const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(() => finish(new Error('ICE gathering timed out. Check network/TURN and retry.')), timeout);
    pc.addEventListener('icegatheringstatechange', changed);
  });
}
