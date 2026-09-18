// 手机侧的运行时读取与任务状态判据。
//
// 折叠执行记录那部分已经删掉了：三条入口（详情/游标轮询、NDJSON 流、本地草稿）
// 现在都在 chat-runtime.js 里折成**桌面形状**的 runtime task，时间线和工具卡由
// 桌面组件渲染。这里只剩两件事：
//   - readNdjson：流式响应按行解析（api.js 的 startTask 用它）
//   - 状态/失败判据：目录、停止按钮、失败回复这些地方还在用
const RUNNING_STATUSES = new Set(['queued', 'running']);
// A task that ends in one of these states never gets a persisted assistant
// message, so both the live row and the thread have to render its partial
// text plus the failure reason on their own.
const FAILURE_STATUSES = new Set(['cancelled', 'failed', 'error']);

export function isTaskRunning(value) {
  return RUNNING_STATUSES.has(value?.status || value);
}

export function isFailureStatus(value) {
  return FAILURE_STATUSES.has(String(value?.status || value || '').trim().toLowerCase());
}

export function isCurrentTaskRunning(liveRun, activeTask) {
  return isTaskRunning(liveRun ?? activeTask);
}

export async function readNdjson(response, onEvent) {
  if (!response.body) throw new Error('Task stream returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent?.(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent?.(JSON.parse(buffer.trim()));
}
