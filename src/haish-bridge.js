// `window.haish` 的接缝：桌面 chat 执行 UI 里的审批卡 / 提问卡 / 浏览器安装卡只认 Electron
// 主进程暴露的那一层接口——`onApprovalEvent` 收实时审批事件、`resolveApproval` 下决定
// （见 haish-agent/src/preload/preload.ts）。手机的适配器没有这套 IPC：
//   * 审批状态只有一份快照（`GET /api/approvals/state`，见 src/api.js 的 approvals()）；
//   * 下决定走三个 HTTP resolve 端点，适配器内部把它们转成 realtime socket 上的
//     `approval.resolve`（server/app.py 的 _resolve_realtime_approval）。
// 所以这里把两边对起来：
//   1) 快照 → 同名的 `approval_snapshot` 事件（桌面 approval-store.js 收到它就整份替换，
//      事件名一个都不用改）；
//   2) `resolveApproval(kind, …)` → 适配器对应的端点；
//   3) 本地下过决定的请求先从后续快照里摘掉，直到后端也不再回报它（手机是秒级轮询，
//      桌面那条 socket 没有这个延迟；不摘的话卡片会「决定完又回来几秒」）。
//
// 快照由 App 那支已有的 5s 轮询喂进来（publishApprovalState）：手机上只留一支轮询，
// 桥不另开一条，也不自己计时。
//
// 浏览器运行时（browser_runtime）是唯一没有通道的一种：适配器只认
// tool / workflow / user_input 三个 approval_kind，core 的 realtime 命令里也没有
// browser_runtime。v1 就让卡片把这句话明着报出来（卡片本身会把错误画在脸上），
// 而不是假装装上了。

/** 快照里所有「还没决定」的列表；每条都带 request_id。 */
const PENDING_KEYS = [
  'pending',
  'pending_workflow_approvals',
  'pending_user_inputs',
  'pending_browser_runtime_installs',
];

export const BROWSER_RUNTIME_UNSUPPORTED = 'Browser runtime installs can only be resolved on the desktop client: the phone adapter has no browser_runtime channel yet.';

export function approvalSnapshotEvent(state) {
  return { type: 'approval_snapshot', state };
}

/**
 * 摘掉本地已经下过决定的请求。
 *
 * `resolved` 是「手机上刚决定过、但还没从后端快照里消失」的 request_id 集合：只要它还在
 * 快照里就继续挡着（卡片决定完就该立刻消失，不能等下一轮轮询把它带走）；快照里已经没有
 * 它了就把它忘掉，集合不会只涨不落。
 */
export function withoutResolved(state, resolved) {
  if (!state || !resolved?.size) return { state, resolved: resolved || new Set() };
  const next = { ...state };
  const present = new Set();
  for (const key of PENDING_KEYS) {
    const list = Array.isArray(state[key]) ? state[key] : null;
    if (!list) continue;
    next[key] = list.filter((item) => {
      const id = String(item?.request_id || '');
      if (!id) return true;
      present.add(id);
      return !resolved.has(id);
    });
  }
  const kept = new Set();
  for (const id of resolved) if (present.has(id)) kept.add(id);
  return { state: next, resolved: kept };
}

/**
 * 一个会话里等着人回的请求。
 *
 * 桌面只有一个窗口、一份 store，`ApprovalInline` 直接把整份 pending 排在当前会话后面；
 * 手机一屏只有一个会话，而 store 是整个 runtime 的——照搬就会把**别的会话**的审批画进
 * 这一轮。收窄按请求自己带的两个作用域字段来：conversation_id 优先，没有就看 task_id
 * 是不是本会话的任务；两个都没有（老 runtime）就只能显示，那是唯一无法归类的形状。
 */
export function scopedPendingRequests(requests, { conversationId = '', taskIds = [] } = {}) {
  const tasks = new Set((Array.isArray(taskIds) ? taskIds : []).filter(Boolean).map(String));
  return (Array.isArray(requests) ? requests : []).filter((request) => {
    const requestConversation = String(request?.conversation_id || '');
    const requestTask = String(request?.task_id || '');
    if (requestConversation) return Boolean(conversationId) && requestConversation === String(conversationId);
    if (requestTask) return tasks.has(requestTask);
    return true;
  });
}

/**
 * 「N actions waiting」那条横幅点进去该开哪个会话：第一条带 conversation_id 的等待中的
 * 请求说了算（顺序与快照一致：工具审批 → 工作流 → 回答 → 浏览器运行时装）。
 */
export function waitingRequestConversation(state) {
  if (!state) return '';
  for (const key of PENDING_KEYS) {
    for (const item of Array.isArray(state[key]) ? state[key] : []) {
      const id = String(item?.conversation_id || '');
      if (id) return id;
    }
  }
  return '';
}

/** 把桌面的 `resolveApproval(kind, id, payload)` 路由到适配器的三个端点。 */
export function resolveApprovalThrough(api, kind, requestId, payload = {}) {
  if (!api) return Promise.reject(new Error('resolveApproval needs the mobile api client.'));
  if (kind === 'tool') return api.resolveApproval(requestId, payload.decision);
  if (kind === 'workflow') return api.resolveWorkflow(requestId, payload.decision, payload.feedback || '');
  if (kind === 'user_input') return api.resolveInput(requestId, payload.answers || []);
  if (kind === 'browser_runtime') return Promise.reject(new Error(BROWSER_RUNTIME_UNSUPPORTED));
  return Promise.reject(new Error(`Unknown approval kind: ${kind}`));
}

export function createHaishBridge({ api, target = null } = {}) {
  const listeners = new Set();
  let resolved = new Set();
  let raw = null;
  let state = null;

  function snapshot() {
    if (!raw) return null;
    const next = withoutResolved(raw, resolved);
    resolved = next.resolved;
    state = next.state;
    return state;
  }

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 一个订阅者炸了不该掐掉其他人（桌面 approval-store 发通知时也是逐条 try）。
      }
    }
  }

  function publish(nextState) {
    raw = nextState;
    const visible = snapshot();
    if (visible) emit(approvalSnapshotEvent(visible));
    return visible;
  }

  const haish = {
    onApprovalEvent(callback) {
      listeners.add(callback);
      // 迟到的订阅者先拿一份当前快照：store 的订阅时机跟首帧渲染的顺序在这里不保证。
      // 这一步跟广播一样逐条挡异常（桌面 approval-store 的 subscribe 也是这么补第一帧的）。
      if (state) {
        try {
          callback(approvalSnapshotEvent(state));
        } catch {
          // 订阅者自己的错，不该把这一次订阅也弄挂。
        }
      }
      return () => listeners.delete(callback);
    },
    async resolveApproval(kind, requestId, payload) {
      const result = await resolveApprovalThrough(api, kind, requestId, payload);
      const id = String(requestId || '');
      if (id) resolved.add(id);
      // 决定过的那条立刻从当前快照里摘掉（raw 不动，只是重新过一遍过滤器）。
      if (raw) publish(raw);
      return result;
    },
  };

  if (target) target.haish = haish;

  return {
    haish,
    publish,
    resolveApproval: haish.resolveApproval,
    getState: () => state,
    dispose() {
      listeners.clear();
      resolved = new Set();
      raw = null;
      state = null;
    },
  };
}

let installed = null;

/** 渲染之前装好（src/main.jsx 模块级调用）：桌面组件挂载时会立刻订阅。 */
export function installHaishBridge(options = {}) {
  installed = createHaishBridge(options);
  return installed;
}

export function haishBridge() {
  if (!installed) {
    throw new Error('installHaishBridge() has not run yet: the window.haish seam must be installed before render (see src/main.jsx).');
  }
  return installed;
}

/** App 的 5s 轮询把快照递进来；返回的是「本地已决定的摘掉之后」的那一份。 */
export function publishApprovalState(state) {
  return haishBridge().publish(state);
}

/** 给不再经过 React 的地方（harness、以后的原生桥）留一个直接入口。 */
export function resolveApprovalDecision(kind, requestId, payload) {
  return haishBridge().resolveApproval(kind, requestId, payload);
}
