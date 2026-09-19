// `window.haish` 的接缝（src/haish-bridge.js）：桌面 chat 的审批卡 / 提问卡 / 浏览器安装卡
// 只认 Electron 主进程那一层（onApprovalEvent + resolveApproval），手机上得由这个模块补上。
// 这里钉住四件事：
//   1) 快照 → `approval_snapshot`（事件名与负载形状照桌面 approval-store.js，事件名改一个字
//      桌面那张卡就再也拿不到数据）；
//   2) 下决定 → 适配器的三个端点；browser_runtime 没有通道，必须明确报错而不是假装成功；
//   3) 手机本地下过决定的请求先从后续快照里摘掉，直到后端也不再回报它（秒级轮询的延迟）；
//   4) 一屏一个会话：别的会话的审批不能画进这一轮（scopedPendingRequests）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// 接缝挂在 `window` 上（桌面 approval-store 读的就是这个对象），node 里要先有这个壳。
import './support/window-stub.mjs';
import {
  BROWSER_RUNTIME_UNSUPPORTED,
  createHaishBridge,
  haishBridge,
  installHaishBridge,
  publishApprovalState,
  resolveApprovalThrough,
  scopedPendingRequests,
  waitingRequestConversation,
  withoutResolved,
} from '../src/haish-bridge.js';

function fakeApi(calls) {
  return {
    resolveApproval: (id, decision) => { calls.push(['tool', id, decision]); return Promise.resolve({ ok: true }); },
    resolveWorkflow: (id, decision, feedback) => { calls.push(['workflow', id, decision, feedback]); return Promise.resolve({ ok: true }); },
    resolveInput: (id, answers) => { calls.push(['user_input', id, answers]); return Promise.resolve({ ok: true }); },
  };
}

const snapshot = () => ({
  mode: 'default',
  pending: [{ request_id: 'tool-1', conversation_id: 'c1', task_id: 't1', tool_name: 'exec_command', raw_command: 'rm -rf build' }],
  pending_workflow_approvals: [{ request_id: 'wf-1', conversation_id: 'c1', approval_kind: 'workflow_human_approval' }],
  pending_user_inputs: [{ request_id: 'ask-1', conversation_id: 'c1', task_id: 't1', questions: [{ id: 'q1', question: 'Which one?' }] }],
  pending_browser_runtime_installs: [{ request_id: 'br-1', conversation_id: 'c2', type: 'browser_runtime_install_required' }],
});

test('resolveApproval 走适配器那三个端点，payload 原样带过去', async () => {
  const calls = [];
  const api = fakeApi(calls);
  await resolveApprovalThrough(api, 'tool', 'tool-1', { decision: 'allow_once' });
  await resolveApprovalThrough(api, 'workflow', 'wf-1', { decision: 'reject', feedback: 'change it' });
  await resolveApprovalThrough(api, 'user_input', 'ask-1', { answers: [{ question_id: 'q1', kind: 'selection', values: ['a'] }] });
  assert.deepEqual(calls, [
    ['tool', 'tool-1', 'allow_once'],
    ['workflow', 'wf-1', 'reject', 'change it'],
    ['user_input', 'ask-1', [{ question_id: 'q1', kind: 'selection', values: ['a'] }]],
  ]);
});

test('browser runtime 没有通道时明确报错，不假装成功', async () => {
  const calls = [];
  await assert.rejects(
    () => resolveApprovalThrough(fakeApi(calls), 'browser_runtime', 'br-1', { decision: 'install' }),
    (error) => error.message === BROWSER_RUNTIME_UNSUPPORTED,
  );
  await assert.rejects(
    () => resolveApprovalThrough(fakeApi(calls), 'nope', 'x', {}),
    /Unknown approval kind/,
  );
  assert.deepEqual(calls, [], '没有通道的那两种不该碰到 api');
});

test('本地已经下过决定的请求从快照里摘掉，后端不再回报它时才忘掉', () => {
  const resolved = new Set(['tool-1']);
  const first = withoutResolved(snapshot(), resolved);
  assert.deepEqual(first.state.pending, []);
  assert.deepEqual(first.state.pending_user_inputs.map((item) => item.request_id), ['ask-1']);
  assert.equal(first.state.mode, 'default', '其它字段照原样带过去');
  assert.deepEqual([...first.resolved], ['tool-1'], '后端还在回报它，就继续挡着');

  const dropped = { ...snapshot(), pending: [] };
  const second = withoutResolved(dropped, first.resolved);
  assert.deepEqual([...second.resolved], [], '后端也不回报了 → 忘掉，集合不会只涨不落');
});

test('快照变成 approval_snapshot 事件，迟到的订阅者也先拿一份当前快照', () => {
  const bridge = createHaishBridge({ api: fakeApi([]) });
  const first = [];
  const stop = bridge.haish.onApprovalEvent((event) => first.push(event));
  bridge.publish(snapshot());
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'approval_snapshot');
  assert.deepEqual(first[0].state.pending.map((item) => item.request_id), ['tool-1']);

  const late = [];
  bridge.haish.onApprovalEvent((event) => late.push(event));
  assert.equal(late.length, 1, '挂载晚的卡片也要立刻有数据');
  assert.equal(late[0].state.pending.length, 1);

  stop();
  bridge.publish({ ...snapshot(), pending: [] });
  assert.equal(first.length, 1, '退订之后不再收到');
  assert.equal(late.length, 2);

  const boom = () => { throw new Error('listener blew up'); };
  bridge.haish.onApprovalEvent(boom);
  const seen = [];
  bridge.haish.onApprovalEvent((event) => seen.push(event));
  bridge.publish(snapshot());
  assert.ok(seen.length >= 1, '一个订阅者炸了不该掐掉其他人');
});

test('下决定之后那张卡立刻从当前快照里消失（不等下一轮轮询）', async () => {
  const bridge = createHaishBridge({ api: fakeApi([]), target: {} });
  const events = [];
  bridge.haish.onApprovalEvent((event) => events.push(event));
  bridge.publish(snapshot());

  await bridge.haish.resolveApproval('tool', 'tool-1', { decision: 'allow_once' });
  const last = events.at(-1);
  assert.deepEqual(last.state.pending, [], '决定过的立刻摘掉');
  assert.deepEqual(last.state.pending_user_inputs.map((item) => item.request_id), ['ask-1']);
  assert.equal(bridge.getState().pending.length, 0);
});

test('按会话收窄：conversation_id 优先，没有就看 task_id，两边都没有才放行', () => {
  const requests = [
    { request_id: 'a', conversation_id: 'c1' },
    { request_id: 'b', conversation_id: 'c2' },
    { request_id: 'c', task_id: 't1' },
    { request_id: 'd', task_id: 't9' },
    { request_id: 'e' },
  ];
  assert.deepEqual(
    scopedPendingRequests(requests, { conversationId: 'c1', taskIds: ['t1'] }).map((item) => item.request_id),
    ['a', 'c', 'e'],
  );
  assert.deepEqual(
    scopedPendingRequests(requests, { conversationId: '', taskIds: ['t1'] }).map((item) => item.request_id),
    ['c', 'e'],
    '会话 id 对不上但任务属于这个会话的仍然算它（请求自己带 conversation_id 时优先那一条）',
  );
});

test('横幅点进去的是第一个带 conversation_id 的等待中的请求', () => {
  assert.equal(waitingRequestConversation(snapshot()), 'c1');
  assert.equal(waitingRequestConversation({ pending: [], pending_user_inputs: [{ request_id: 'a', conversation_id: 'c7' }] }), 'c7');
  assert.equal(waitingRequestConversation({ pending: [{ request_id: 'a' }] }), '');
  assert.equal(waitingRequestConversation(null), '');
});

test('装到 window 上的那两个键就是桌面 preload 的形状', async () => {
  const target = {};
  const calls = [];
  const installed = installHaishBridge({ api: fakeApi(calls), target });
  assert.equal(typeof target.haish.onApprovalEvent, 'function');
  assert.equal(typeof target.haish.resolveApproval, 'function');
  assert.equal(haishBridge(), installed);

  publishApprovalState(snapshot());
  assert.equal(haishBridge().getState().pending_user_inputs.length, 1);
  await target.haish.resolveApproval('user_input', 'ask-1', { answers: [] });
  assert.deepEqual(calls, [['user_input', 'ask-1', []]]);
});

// 光把桥建出来还不够，接缝得真的挂到 `window` 上：桌面 approval-store 的 `ensureStream`
// 只认 `window.haish`，查不到就 `console.warn` 一句、之后再也不订阅。1.53~1.58 的手机包
// 就是这么静的——main.jsx 调的是 `installHaishBridge({ api })`，一个 target 都没传。
test('不给 target 时，接缝挂在 window 上（桌面 store 读的就是它）', () => {
  const installed = installHaishBridge({ api: fakeApi([]) });
  assert.equal(window.haish, installed.haish);
  assert.equal(typeof window.haish.onApprovalEvent, 'function');
  assert.equal(typeof window.haish.resolveApproval, 'function');

  // store 的 start()（ensureStream）比挂载晚：模拟它订阅时拿到的那第一帧。
  publishApprovalState(snapshot());
  const seen = [];
  const stop = window.haish.onApprovalEvent((event) => seen.push(event));
  assert.equal(seen.length, 1, '迟到的订阅者也要立刻拿到当前快照');
  assert.deepEqual(seen[0].state.pending_user_inputs.map((item) => item.request_id), ['ask-1']);
  stop();
});

// 光装桥还不够：桌面的 approval-store 是懒订阅的（`ensureStream` 只在 `start()` 里跑，桌面
// 在 AppShell 里开这一下）。手机上 main.jsx 就是那个壳——漏掉这一句，四张卡全是空的，而
// 「空」不报错、单测也不会红（第一次跑样机就是这么静的），所以把顺序钉在这里。
test('main.jsx 在渲染前装桥，接着开 approval-store 的订阅', async () => {
  const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  const installAt = source.indexOf('installHaishBridge({ api })');
  const startAt = source.indexOf('approvalStore.start()');
  assert.ok(installAt >= 0, '渲染前要装 window.haish（桌面组件挂载时就订阅）');
  assert.ok(startAt > installAt, '桥装好之后还要 approvalStore.start()：store 不 start 就不订阅，四张卡都收不到东西');
});

// 四张卡的主体必须是桌面那几张卡。手机自己画过一版（App.jsx 里那个 ApprovalCard，用户看到
// 的是跟客户端不一样的「ACTION REQUIRED」），这条盯住「不再自己画」。
test('末尾插槽用的是桌面的卡，不是手机画的', async () => {
  const slot = await readFile(new URL('../src/approval-slot.jsx', import.meta.url), 'utf8');
  assert.match(
    slot,
    /from '\.\.\/\.\.\/haish-agent\/app-web\/src\/features\/approvals\/components\/ApprovalOverlay\.jsx'/,
    '卡本体从桌面的 ApprovalOverlay 取',
  );
  for (const name of ['ToolApprovalCard', 'BrowserRuntimeCard', 'WorkflowApprovalInline']) {
    assert.ok(slot.includes(name), `插槽里要用桌面的 ${name}`);
  }
});
