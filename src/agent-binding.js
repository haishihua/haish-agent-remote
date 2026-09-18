// 「这个会话的 agent 还能不能换」在手机端只有这一处判据，规则和桌面端、runtime 是同一条。
//
// runtime 在会话的第一个被接受的 chat turn 上写死 agent 绑定（`set_agent_profile`），
// 之后再带别的 `agent_id` 发任务一定 400：“Conversation is bound to agent X. Create a
// new conversation to use Y.”。所以只有「这个会话已经发过消息」才该锁上，新会话必须能选。
//
// 判据只用服务端的两样事实：
//   1. 会话自己的任务记录：有任务就是发过；
//   2. 时间线里的用户消息：服务端已经收下过这一轮。
// 只上传过图片不算——`POST /api/messages/images` 只是往会话里存一个文件，一个字都还没写。
// 只在本机的那一笔（还没被服务端接下）也不算，所以这里不读本机的乐观消息，也不读
// `conversation.agent_id`：发送失败时那是个还没被确认的乐观值，不能当绑定用。
export function conversationHasSentMessage({ tasks = [], messages = [] } = {}) {
  if ((Array.isArray(tasks) ? tasks : []).length > 0) return true;
  return (Array.isArray(messages) ? messages : []).some((message) => String(message?.role || '') === 'user');
}
