// 线程末尾那个「还等着人回」的插槽。
//
// 桌面把这件事写成 `ApprovalInline`（ApprovalOverlay.jsx）：整份 store 里除了工作流审批和
// 已经被工具节点认领的请求，剩下的排在当前会话所有消息之后，一次显示一条 + “N pending
// requests queued”。手机一屏只有一个会话，而 store 是整个 runtime 的一份——照搬那个组件会
// 把**别的会话**的审批画进这一轮，所以这里做同一件事、按会话收窄（见 haish-bridge.js 的
// `scopedPendingRequests`）。
//
// 卡片本体一行都没有自己画：
//   * 工具审批 / 浏览器运行时装 → 桌面的 `ToolApprovalCard`（= BrowserRuntimeCard）；
//   * 工作流审批 → 桌面的 `WorkflowApprovalInline`（传请求自己的 task_id，把它的作用域
//     钉死在这一条上）；
//   * 外层行与气泡用的是桌面 ApprovalInline 那套类名（`.chat-message-row.agent
//     .haish-approval-row` + `.haish-approval-slot`），样式在 approvals.css 里，手机已经
//     把它整段接进来了（src/desktop-theme.css）。
//
// 认领机制照桌面：工具节点里那张内嵌卡（`embedded` / 末尾插槽）先挂就先认领，认领过的请求这里不再画，
// 于是「时间线里能看到就不重复、看不到才落到末尾」这条规矩在手机上一样成立。
import React from 'react';
import { approvalStore, isBrowserRuntimeRequest, isWorkflowApprovalRequest } from '../../haish-agent/app-web/src/features/approvals/model/approval-store.js';
import * as DesktopApprovalCards from '../../haish-agent/app-web/src/features/approvals/components/ApprovalOverlay.jsx';
// CI pins the earlier BrowserRuntimeCard export; current desktop renamed it.
// Namespace lookup keeps both source revisions buildable without changing either renderer.
const { ToolApprovalCard, WorkflowApprovalInline } = DesktopApprovalCards;
const BrowserRuntimeCard = DesktopApprovalCards['RuntimeApprovalCard'] || DesktopApprovalCards['BrowserRuntimeCard'];
import { scopedPendingRequests } from './haish-bridge.js';

function usePendingApprovals() {
  const [pending, setPending] = React.useState([]);
  React.useEffect(() => approvalStore.subscribe(setPending), []);
  return pending;
}

function scopeKey(conversationId, taskIds) {
  return `${conversationId}\u0000${(taskIds || []).join('\u0000')}`;
}

function ChatApprovalSlotComponent({ conversationId = '', taskIds = [] }) {
  const pending = usePendingApprovals();
  const scope = scopeKey(conversationId, taskIds);
  const scoped = React.useMemo(
    () => scopedPendingRequests(pending, { conversationId, taskIds }),
    // scope 把 conversationId / taskIds 摊平成一个字符串：taskIds 每次渲染都是新数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, scope],
  );

  const workflow = scoped.find(isWorkflowApprovalRequest) || null;
  // 同 ApprovalInline：已经被工具节点里那张内嵌卡认领的请求不再在末尾重复画一次（认领是
  // 独占的，后挂的那张自己也会 return null，但那样会把排在它后面的请求一起挡住——
  // 这里先滤掉，队列里剩下的才是真没人管的）。
  const visible = scoped.filter(
    (request) => !isWorkflowApprovalRequest(request) && !approvalStore.isBrowserRuntimeClaimed(request.request_id),
  );
  const active = visible[0] || null;
  const rest = visible.length - 1;
  if (!active && !workflow) return null;

  return (
    <>
      {active ? (
        <div className="chat-message-row agent haish-approval-row">
          <div className="chat-bubble">
            <div className="haish-approval-slot">
              {isBrowserRuntimeRequest(active)
                ? <BrowserRuntimeCard request={active} />
                : <ToolApprovalCard request={active} />}
              {rest > 0 ? (
                <div className="haish-approval-queue">
                  {rest} pending request{rest === 1 ? '' : 's'} queued
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {workflow ? (
        <WorkflowApprovalInline
          conversationId={conversationId}
          taskId={workflow.task_id || ''}
        />
      ) : null}
    </>
  );
}

// ConversationDetail may update for composer and stream state; approval cards subscribe to their
// own store and only need parent renders when this conversation scope changes.
export const ChatApprovalSlot = React.memo(ChatApprovalSlotComponent);
