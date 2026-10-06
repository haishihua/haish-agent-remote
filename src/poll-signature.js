/**
 * 轮询拿回来的东西和上一次一模一样时，别再把同一份数据塞回 state：详情页那一棵是几千个节点、
 * 目录是几百行，重渲染一次就是几十毫秒的主线程活——落进手势或键盘动画里就是一帧卡顿。
 * 这里给出两把「画出来的东西有没有变」的尺子。
 *
 * 两把尺子都只比会画到屏幕上的字段，而不是整份 payload：最大的一份会话是 1.7MB，`JSON.stringify`
 * 它本身就是另一笔开销；而且里面还有每次请求都在动的字段（`device.last_seen_at` 由服务端的
 * `authenticate` 每一问都刷新）。代价是漏一个字段就等于那个字段在轮询里不再更新，所以下面的
 * 字段清单是照着「谁在读它」列的——改界面时一起看这里。
 */

/** 消息内容可能是字符串，也可能是多段（text / image）数组。 */
function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + String(part?.text ?? part?.content ?? part?.url ?? '').length, 0);
  }
  return content ? String(content).length : 0;
}

/**
 * 一条任务里会被画出来的字段：
 *
 * - `status` / `created_at` / `completed_at`：`activeTask`、任务行的耗时（`formatElapsedDuration`）；
 * - `assistant_message_id`：`orphanTaskReplies` 据此决定要不要在本地补一条回复；
 * - `answer_text` 的长度与 `error`：本地补的那条回复直接画它们；
 * - `request_options` 里那一组 + 几个平铺字段：`resolveRunConfig` 靠它们还原「这个会话上次是怎么跑的」；
 * - `image_attachments`：用户那条消息上的图片（`messageImageRefs`）。
 */
function taskSignature(task) {
  const options = task?.request_options && typeof task.request_options === 'object' ? task.request_options : null;
  return [
    task?.task_id || '',
    task?.status || '',
    task?.created_at || '',
    task?.completed_at || '',
    task?.assistant_message_id || '',
    contentLength(task?.answer_text),
    task?.error ? 'failed' : '',
    options ? [options.provider, options.model_id, options.agent_id, options.reasoning_effort].join('~') : '',
    task?.provider_key || task?.provider || '',
    task?.model || '',
    task?.request_model_id || '',
    task?.request_provider || task?.requested_provider || task?.provider_selector || '',
    task?.agent_id || task?.profile_id || '',
    JSON.stringify(task?.image_attachments || null),
  ].join(':');
}

/**
 * 详情页那份会话：消息条数 + 最后一条消息的标识与内容长度（覆盖「回答在长」和「又来了新消息」，
 * 消息只会往后追加），一条任务一行的签名覆盖任务那一侧；标题和发消息要用的几个字段也算进来。
 */
export function conversationSignature(conversation) {
  const messages = conversation?.messages || [];
  const last = messages[messages.length - 1] || null;
  return [
    conversation?.conversation_id || '',
    conversation?.title || '',
    conversation?.execution_mode || '',
    conversation?.profile_display_name || '',
    conversation?.last_task_id || '',
    conversation?.agent_id || conversation?.profile_id || '',
    messages.length,
    last ? `${last.message_id || last.id || ''}:${contentLength(last.content)}` : '',
    (Array.isArray(conversation?.tasks) ? conversation.tasks : []).map(taskSignature).join('|'),
  ].join('§');
}

/**
 * 连接状态：`paired`、`runtime_online`、机型（目录页头和设置页都画）、版本、当前设备（设置页拿它
 * 标「Sign out」，也拿它当设备列表的兜底行）。`device.last_seen_at` 故意不比——服务端每次鉴权都
 * 刷新它，比了就等于每次都在变。
 */
export function statusSignature(status) {
  const device = status?.device || null;
  return [
    status?.paired ? 'paired' : 'unpaired',
    status?.runtime_online ? 'online' : 'offline',
    status?.computer_model || '',
    status?.version || '',
    status?.notifications?.enabled ? 'bark' : 'local',
    device ? `${device.device_id || ''}:${device.name || ''}` : '',
  ].join('|');
}
