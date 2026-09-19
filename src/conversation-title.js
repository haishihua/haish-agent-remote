import { isDefaultConversationName, titleFromTaskText } from '../../haish-agent/app-web/src/features/conversations/model/workspace-state.js';

/**
 * 新建会话的名字。
 *
 * 桌面建会话时先写一个占位名（`DEFAULT_SESSION_NAME`），再把「第一条消息」换成一句话摘要
 * （`createDraftConversationHandlers.materializeDraftConversationForSend` 与
 * `createDeployHandlers.startDeploy`：`titleFromTaskText` + `isDefaultConversationName`）。
 * 手机走的是同一条路，只是占位名取桌面默认名里那句中性的：这样两边都认它是占位名，谁先把
 * 第一条消息发出去，谁就把它换掉。
 */
export const NEW_CONVERSATION_TITLE = 'New Chat';

/** 这个名字还是占位名（不是用户自己起的）：第一条消息可以把它换掉。判据直接用桌面那一条。 */
export function isPlaceholderConversationTitle(title) {
  return isDefaultConversationName(title);
}

/**
 * 一条消息能把会话名换成什么：桌面给会话起名用的就是 `titleFromTaskText`（空白折叠、48 字截断）。
 * 空串表示这一条带不起名字（纯图片），调用方按桌面的判据跳过换名。
 */
export function conversationTitleForMessage(text) {
  return titleFromTaskText(text);
}
