// 「任务失败 → Retry」这条链路的契约。
//
// 用户看到的症状是「样式有了但点不动」：桌面 ChatMessageRow 在失败行上永远画那颗
// Retry 药丸（ErrorState 的 block 变体不给 onRetry 也会画，只是 disabled），而手机这边
// 从来没有传过 onRetry——按钮在、就是死的。所以这里钉三件在源码里能验的事：
//   1. 只有「这个会话的最后一轮、状态 failed」那一行拿到 onRetry（runtime 的 rerun 只接这种）；
//   2. 手机有真正发得出去的 API + 适配器路由（`api.retryTask` → `/remote/.../retry`）；
//   3. 被拒（409）时那一行要放回来，并把原因报给用户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8');

test('只有最后一轮失败行拿到 Retry 回调', async () => {
  const source = await read('src/chat-view.jsx');
  assert.match(
    source,
    /const retryable = Boolean\(onRetryTask\) && row\.role === 'agent' && row\.status === 'failed'\s*\n\s*&& row\.taskId && row\.taskId === retryableTaskId;/,
    'Retry 的准入条件必须包含 role/status/taskId === retryableTaskId',
  );
  // 不能无条件传：其余失败行要保留桌面那颗带 title 的禁用按钮。
  assert.match(source, /onRetry=\{retryable \? onRetryTask : undefined\}/);
  assert.match(source, /retryPending=\{Boolean\(retryPendingTaskId\) && row\.taskId === retryPendingTaskId\}/);
  // 会话正在跑 / 正在等接单时按钮不可点（runtime 那边同样会 409）。
  assert.match(source, /actionsDisabled=\{Boolean\(row\.streaming\) \|\| retryBlocked\}/);
});

test('App 用会话的最后一轮判定重跑资格并转发给线程', async () => {
  const source = await read('src/App.jsx');
  assert.match(source, /const lastTaskId = String\(conversation\?\.last_task_id/);
  assert.match(source, /onRetryTask=\{retryRow\}/);
  assert.match(source, /retryableTaskId=\{lastTaskId\}/);
  assert.match(source, /retryPendingTaskId=\{retryPendingTaskId\}/);
  assert.match(source, /retryBlocked=\{busy \|\| running\}/);
  // 过了接单这一关再顶掉旧行：runtime 拒了（409）就要放回去。
  assert.match(source, /retriedTaskIdsRef\.current = previousRetried;/);
  assert.match(source, /pushToast\('error', nextError\.message\)/);
  assert.match(source, /for \(const taskId of retriedTaskIds\) replies\.delete\(taskId\);/);
});

test('重跑走适配器的 rerun 路由，而不是再发一条消息', async () => {
  const api = await read('src/api.js');
  assert.match(api, /retryTask: async \(conversationId, taskId, runOptions, onEvent, onOpen\)/);
  assert.match(api, /\/remote\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/retry/);

  const server = await read('server/app.py');
  // 与桌面同一条命令：type 不变，operation 是 rerun，并且带 task_id。
  assert.match(server, /@app\.post\("\/remote\/conversations\/\{conversation_id\}\/tasks\/\{task_id\}\/retry"\)/);
  assert.match(server, /operation="rerun"/);
  assert.match(server, /if self\.task_id:\n\s+command\["task_id"\] = self\.task_id/);
  // rerun 的 body 只有 request_id + 路线选择：多一个 message 会被 runtime 400。
  assert.match(server, /for key in \("llm_config_id", "provider", "model_id", "reasoning_effort"\):/);
  assert.doesNotMatch(server, /_retry_payload[\s\S]{0,400}"message"/);
});
