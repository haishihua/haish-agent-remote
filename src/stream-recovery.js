import { runtimeTaskFromSummary } from './chat-runtime.js';
import { persistedAssistantForTask } from './task-settlement.js';
import { isFailureStatus, isTaskRunning } from './task-stream.js';

// Transport failure is not a task outcome. Only the record for this exact
// task may replace the live status; never pick the conversation's newest task.
export function reconcileInterruptedRun(previous, conversation, taskState = null) {
  const taskId = previous?.taskId;
  if (!taskId) return { run: previous, resolved: false };
  const summary = conversation?.tasks?.find((task) => task.task_id === taskId);
  const persisted = persistedAssistantForTask(conversation, taskId);
  let run = taskState?.taskId === taskId ? taskState : previous;
  if (summary) run = runtimeTaskFromSummary(summary, run);
  // A conversation poll may have started before a task-detail poll observed
  // completion. Never resurrect that terminal task with an older running record.
  if (previous && !isTaskRunning(previous.status) && isTaskRunning(run.status)) run = previous;
  if (isTaskRunning(run?.status) && !run.answerText && previous?.answerText) {
    run = { ...run, answerText: previous.answerText };
  }
  if (persisted && !isFailureStatus(summary?.status || run?.status)) {
    return { run: null, resolved: true };
  }
  const authoritative = Boolean(summary || taskState?.taskId === taskId);
  if (!authoritative) return { run: previous, resolved: false };
  // A real server failure retains its partial answer/trace and error. A done
  // task without a durable message retains its answer until persistence catches up.
  return {
    run,
    resolved: isFailureStatus(run.status),
    running: isTaskRunning(run.status),
  };
}

export function interruptedStreamNotice(error) {
  return `Task stream disconnected; checking server status. Do not resend this task. ${error?.message || 'Connection interrupted.'}`;
}
