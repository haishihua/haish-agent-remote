import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DesktopSession, waitForIce } from '../src/desktop-session.js';

function live(options = {}) {
  let clock = 1000;
  const commands = [];
  const states = [];
  const ended = [];
  const session = new DesktopSession({ desktopEnd: async (id) => ended.push(id) }, {
    now: () => clock, onState: (...args) => states.push(args), ...options,
  });
  session.pc = { connectionState: 'connected', close() {} };
  session.dc = { readyState: 'open', bufferedAmount: 0, send: (raw) => commands.push(JSON.parse(raw)), close() {} };
  session.epoch = 'current'; session.ticket = 'ticket'; session.paused = false; session.inputUntil = clock + 750;
  session.lastReady = clock; session.startedAt = clock; session.firstFrame = true; session.id = 'test';
  return { session, commands, states, ended, advance: (ms) => { clock += ms; } };
}

test('input uses current lease and sequence, with no offline queue', () => {
  const { session, commands, advance } = live();
  assert.equal(session.send({ type: 'text', text: '中文' }), true);
  assert.deepEqual(commands[0], { type: 'text', text: '中文', generation: 0, epoch: 'current', ticket: 'ticket', seq: 1 });
  advance(2000);
  assert.equal(session.send({ type: 'key', key: 'Cmd', down: true }), false);
  session.disconnected();
  assert.equal(session.send({ type: 'text', text: 'discard' }), false);
  assert.equal(commands.filter((c) => !['ping', 'resume'].includes(c.type)).length, 1);
  session.close();
});

test('foreground reconnect times out at 30 seconds and requires manual connect', () => {
  const { session, advance, states, ended } = live();
  session.disconnected();
  advance(30000); session.tick();
  assert.equal(session.closed, true);
  assert.equal(states.at(-1)[0], 'failed');
  assert.deepEqual(ended, ['test']);
});

test('end releases state, closes once, and cannot send again', () => {
  const { session, commands, ended } = live();
  session.close(); session.close();
  assert.equal(commands[0].type, 'release');
  assert.equal(session.send({ type: 'click', button: 'left' }), false);
  assert.deepEqual(ended, ['test']);
});

test('congested channel drops input rather than queueing it', () => {
  const { session, commands } = live();
  session.dc.bufferedAmount = 10000;
  assert.equal(session.send({ type: 'move', dx: .1, dy: .1 }), false);
  assert.equal(commands.length, 0);
  session.close();
});

test('lock, lost permission and revoked pairing explain termination', async () => {
  const { session, states } = live();
  session.api.desktopStatus = async () => ({ enabled: true, unlocked: false });
  await session.checkAuthorization();
  assert.equal(session.closed, true);
  assert.match(states.at(-1)[1], /locked/);
  const revoked = live();
  revoked.session.api.desktopStatus = async () => { throw Object.assign(new Error(), { status: 401 }); };
  await revoked.session.checkAuthorization();
  assert.match(revoked.states.at(-1)[1], /revoked/);
});

test('missing first frame fails rather than showing connected forever', () => {
  const { session, advance, states } = live();
  session.firstFrame = false;
  advance(11000); session.lastReady = session.now(); session.tick();
  assert.equal(session.closed, true);
  assert.equal(states.at(-1)[0], 'failed');
});

function reply(session, ping, type, epoch = 'fresh', ticket = 'fresh-ticket') {
  session.response(JSON.stringify({ type, probe: ping.probe, generation: ping.generation,
    epoch, ticket, validForMs: 1000 }));
}

test('pause discards buffered ready and challenge; resume requires fresh generation handshake', () => {
  const { session, commands, advance } = live();
  session.ping();
  const oldPing = commands.at(-1);
  assert.equal(session.send({ type: 'key', key: 'Cmd', down: true }), true);
  const buffered = commands.at(-1);
  advance(2500); session.tick();
  assert.equal(session.paused, true);
  assert.equal(session.generation, 1);
  assert.equal(buffered.generation, 0); // SCTP queue still exists; cannot reuse this generation.
  reply(session, oldPing, 'ready', 'current', 'ticket');
  reply(session, oldPing, 'challenge', 'current', 'ticket');
  assert.equal(session.epoch, null);
  assert.equal(session.send({ type: 'text', text: 'discard' }), false);
  const newPing = commands.at(-1);
  reply(session, newPing, 'ready'); // unsolicited ready cannot arm paused client
  assert.equal(session.paused, true);
  reply(session, newPing, 'challenge');
  assert.equal(commands.at(-1).type, 'resume');
  assert.equal(session.paused, true);
  reply(session, newPing, 'ready');
  assert.equal(session.paused, false);
  assert.equal(session.offlineSince, null);
  assert.equal(session.send({ type: 'text', text: 'new' }), true);
  assert.equal(commands.at(-1).generation, 1);
  assert.equal(commands.at(-1).ticket, 'fresh-ticket');
  assert.deepEqual([...session.heldKeys], []);
  session.close();
});

test('delayed response cannot extend validity from its receipt time', () => {
  const { session, commands, advance } = live();
  session.disconnected(); session.ping();
  const ping = commands.at(-1);
  advance(800);
  reply(session, ping, 'challenge');
  assert.equal(commands.at(-1).type, 'ping'); // no resume of expired probe
  assert.equal(session.paused, true);
  session.close();
});

test('late ready after client expiry forces generation change even before tick', () => {
  const { session, commands, advance } = live();
  advance(500); session.ping();
  const ping = commands.at(-1);
  advance(300); reply(session, ping, 'ready', 'current', 'new-ticket');
  assert.equal(session.paused, true);
  assert.equal(session.generation, 1);
  assert.equal(session.epoch, null);
  session.close();
});

test('held-state heartbeat releases missing ups without replaying downs on resume', () => {
  const { session, commands } = live();
  session.send({ type: 'key', key: 'Cmd', down: true });
  session.send({ type: 'button', button: 'left', down: true });
  session.ping();
  assert.deepEqual(commands.at(-1).heldKeys, ['Cmd']);
  assert.deepEqual(commands.at(-1).heldButtons, ['left']);
  session.send({ type: 'release' }); session.ping();
  assert.deepEqual(commands.at(-1).heldKeys, []);
  assert.deepEqual(commands.at(-1).heldButtons, []);
  session.close();
});

test('backpressure dropping an up still advertises release on the next heartbeat', () => {
  const { session, commands } = live();
  session.send({ type: 'key', key: 'Cmd', down: true });
  session.send({ type: 'button', button: 'left', down: true });
  session.dc.bufferedAmount = 10000;
  assert.equal(session.send({ type: 'key', key: 'Cmd', down: false }), false);
  assert.equal(session.send({ type: 'button', button: 'left', down: false }), false);
  session.dc.bufferedAmount = 0; session.ping();
  assert.deepEqual(commands.at(-1).heldKeys, []);
  assert.deepEqual(commands.at(-1).heldButtons, []);
  session.close();
});

test('connect configures bounded partial-reliable ordered SCTP input', async () => {
  let options;
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'connected'; }
    addTransceiver() {}
    createDataChannel(label, config) {
      assert.equal(label, 'input'); options = config;
      return { readyState: 'open', bufferedAmount: 0, send() {}, close() {} };
    }
    async createOffer() { return { type: 'offer', sdp: 'synthetic' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {}
    close() {}
  }
  const session = new DesktopSession({ desktopIce: async () => ({ iceServers: [] }),
    desktopOffer: async () => ({ type: 'answer', sdp: 'synthetic', session_id: 'test' }), desktopEnd: async () => {} }, { Peer });
  await session.connect();
  assert.deepEqual(options, { ordered: true, maxPacketLifeTime: 250 });
  session.close();
});

test('metrics measure heartbeat RTT only after a fresh accepted ready', () => {
  const metrics = [];
  const { session, commands, advance } = live({ onMetrics: (value) => metrics.push(value) });
  advance(100); session.ping();
  const ping = commands.at(-1);
  advance(42);
  reply(session, ping, 'ready', 'current', 'next-ticket');
  assert.deepEqual(metrics, [{ rttMs: 42 }]);
  reply(session, ping, 'ready', 'current', 'next-ticket'); // consumed probe
  assert.equal(metrics.length, 1);
  assert.equal(session.send({ type: 'text', text: 'still authorized' }), true);
  session.close();
  reply(session, ping, 'ready', 'current');
  assert.equal(metrics.length, 1);
});

test('metrics cannot bypass resume handshake or report stale and invalid responses', () => {
  const metrics = [];
  const { session, commands, advance } = live({ onMetrics: (value) => metrics.push(value) });
  session.ping(); const stale = commands.at(-1);
  session.disconnected(); session.ping(); const ping = commands.at(-1);
  reply(session, stale, 'ready', 'current');
  reply(session, ping, 'ready'); // no challenge/resume yet
  session.response(JSON.stringify({ type: 'ready', probe: ping.probe, generation: ping.generation,
    epoch: 'fresh', ticket: 'fresh-ticket', validForMs: 0 }));
  reply(session, ping, 'challenge');
  reply(session, ping, 'ready', 'fresh', 'wrong-ticket');
  assert.deepEqual(metrics, []);
  assert.equal(session.paused, true);
  advance(25); reply(session, ping, 'ready');
  assert.deepEqual(metrics, [{ rttMs: 25 }]);
  assert.equal(session.paused, false);
  session.ping(); const expired = commands.at(-1);
  advance(750); reply(session, expired, 'ready');
  assert.equal(metrics.length, 1);
  session.close();
});

function stats(...reports) { return new Map(reports.map((report) => [report.id, report])); }

function selectedStats(localType = 'host', remoteType = 'srflx') {
  return stats(
    { id: 'video', type: 'inbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080,
      framesPerSecond: 29.5, packetsReceived: 100, packetsLost: 0 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'other', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'unused' },
    { id: 'unused', type: 'local-candidate', candidateType: 'relay', address: 'private address' },
    { id: 'selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: localType, address: 'private address', port: 5000 },
    { id: 'remote', type: 'remote-candidate', candidateType: remoteType, address: 'private address' },
  );
}

test('stats emit measured video and actual selected direct/relay path without candidate details', async () => {
  const metrics = [];
  const { session } = live({ onMetrics: (value) => metrics.push(value) });
  session.pc.getStats = async () => selectedStats();
  await session.adapt();
  assert.deepEqual(metrics, [{ width: 1920, height: 1080, fps: 29.5, connectionType: 'direct' }]);
  session.pc.getStats = async () => selectedStats('host', 'relay');
  await session.adapt();
  assert.deepEqual(metrics[1], { width: 1920, height: 1080, fps: 29.5, connectionType: 'relay' });
  session.close();
});

test('stats do not fabricate missing video metrics or infer routing from successful checks', async () => {
  const metrics = [];
  const { session } = live({ onMetrics: (value) => metrics.push(value) });
  session.pc.getStats = async () => stats(
    { id: 'video', type: 'inbound-rtp', kind: 'video', frameWidth: NaN, frameHeight: 0, framesPerSecond: -1 },
    { id: 'audio', type: 'inbound-rtp', kind: 'audio', frameWidth: 999, framesPerSecond: 100 },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: .3 },
    { id: 'local', type: 'local-candidate', candidateType: 'relay' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host' },
  );
  await session.adapt();
  assert.deepEqual(metrics, []);
  assert.equal(session.quality, 'low'); // existing adaptation still works
  session.pc.getStats = async () => stats({ id: 'video', type: 'inbound-rtp', mediaType: 'video', frameHeight: 720, framesPerSecond: 0 });
  await session.adapt();
  assert.deepEqual(metrics, [{ height: 720, fps: 0 }]);
  session.close();
});

test('selected-pair compatibility markers work but incomplete candidate types remain unknown', async () => {
  const metrics = [];
  const { session } = live({ onMetrics: (value) => metrics.push(value) });
  for (const marker of [{ selected: true }, { nominated: true, state: 'succeeded' }]) {
    session.pc.getStats = async () => stats(
      { id: 'pair', type: 'candidate-pair', ...marker, localCandidateId: 'local', remoteCandidateId: 'remote' },
      { id: 'local', type: 'local-candidate', candidateType: 'prflx' },
      { id: 'remote', type: 'remote-candidate', candidateType: 'host' },
    );
    await session.adapt();
  }
  assert.deepEqual(metrics, [{ connectionType: 'direct' }, { connectionType: 'direct' }]);
  session.pc.getStats = async () => stats(
    { id: 'pair', type: 'candidate-pair', selected: true, localCandidateId: 'local' },
    { id: 'local', type: 'local-candidate', candidateType: 'host' },
  );
  await session.adapt();
  assert.equal(metrics.length, 2);
  session.close();
});

test('closed sessions neither request stats nor apply in-flight stats or adaptation', async () => {
  const metrics = [];
  const { session } = live({ onMetrics: (value) => metrics.push(value) });
  let resolve, calls = 0;
  session.pc.getStats = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const pending = session.adapt();
  await session.adapt(); // avoid overlapping polls
  assert.equal(calls, 1);
  session.close();
  const reports = selectedStats();
  reports.set('slow', { id: 'slow', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: .5 });
  resolve(reports); await pending;
  await session.adapt();
  assert.equal(calls, 1);
  assert.deepEqual(metrics, []);
  assert.equal(session.quality, 'high');
  assert.equal(session.lastStats, undefined);
});

test('stats errors and throwing metrics observers never break session behavior', async () => {
  const { session, commands, advance } = live({ onMetrics: () => { throw new Error('observer'); } });
  session.pc.getStats = async () => { throw new Error('stats unavailable'); };
  await session.adapt();
  assert.equal(session.checkingStats, false);
  session.pc.getStats = async () => selectedStats();
  await session.adapt();
  advance(100); session.ping(); advance(20);
  reply(session, commands.at(-1), 'ready', 'current');
  assert.equal(session.send({ type: 'text', text: 'works' }), true);
  session.close();
});

test('closing during remote description does not restart lifecycle timers', async () => {
  let resolveRemote, reachedRemote;
  const remoteStarted = new Promise((resolve) => { reachedRemote = resolve; });
  const ended = [];
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; }
    addTransceiver() {}
    createDataChannel() { return { readyState: 'open', bufferedAmount: 0, send() {}, close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'synthetic' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    setRemoteDescription() { reachedRemote(); return new Promise((resolve) => { resolveRemote = resolve; }); }
    close() {}
  }
  const session = new DesktopSession({ desktopIce: async () => ({ iceServers: [] }),
    desktopOffer: async () => ({ type: 'answer', sdp: 'synthetic', session_id: 'test' }),
    desktopEnd: async (id) => ended.push(id) }, { Peer });
  const connecting = session.connect();
  await remoteStarted;
  session.close(); resolveRemote(); await connecting;
  assert.deepEqual(ended, ['test']);
  assert.equal(session.timer, undefined);
  assert.equal(session.statsTimer, undefined);
  assert.equal(session.statusTimer, undefined);
});

test('ICE wait is bounded and removes its listener', async () => {
  let removed = false;
  const pc = { iceGatheringState: 'gathering', addEventListener() {}, removeEventListener() { removed = true; } };
  await assert.rejects(waitForIce(pc, 1), /timed out/);
  assert.equal(removed, true);
});

test('page and native lifecycle terminate desktop only, not Haish tasks', () => {
  const ui = readFileSync(new URL('../src/remote-desktop.jsx', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../ios/App/App/AppDelegate.swift', import.meta.url), 'utf8');
  assert.match(ui, /visibilitychange/);
  assert.match(ui, /pagehide/);
  assert.match(ui, /haish:app-state/);
  assert.match(native, /applicationWillResignActive[\s\S]*endDesktopOnBackground/);
  assert.doesNotMatch(ui, /cancelTask|stopTask|taskCancel/);
  assert.doesNotMatch(readFileSync(new URL('../src/api.js', import.meta.url), 'utf8'), /AbortSignal\.timeout/);
});
