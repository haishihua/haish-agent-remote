import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createTaskNotificationTracker, taskNotificationStatus } from '../src/task-notification-policy.js';
import { observeNotificationTask, startTaskNotifications } from '../src/task-notifications.js';

const conversation = { conversation_id: 'c1', title: '修复登录流程' };
const task = (status, extra = {}) => ({ task_id: 't1', status, ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(notify) {
  const calls = [];
  const tracker = createTaskNotificationTracker({ now: () => 1000, notify: notify || ((item) => calls.push(item)) });
  return { calls, tracker };
}

test('only completion/failure statuses notify, not cancellation or connection errors', () => {
  for (const status of ['done', 'completed', 'DONE']) assert.equal(taskNotificationStatus(task(status)), 'done');
  for (const status of ['failed', 'error']) assert.equal(taskNotificationStatus(task(status)), 'failed');
  for (const status of ['running', 'queued', 'cancelled', 'aborted', '', 'stream-read']) {
    assert.equal(taskNotificationStatus(task(status)), null);
  }
});

test('historical terminal rows are silent, active-to-terminal transitions notify once', async () => {
  const { calls, tracker } = fixture();
  tracker.observe(task('done', { completed_at: 900 }), conversation);
  tracker.observe(task('done', { completed_at: 900 }), conversation);
  tracker.observe(task('running', { task_id: 't2' }), conversation);
  tracker.observe(task('done', { task_id: 't2' }), conversation);
  tracker.observe(task('completed', { task_id: 't2' }), conversation);
  await flush();
  tracker.observe(task('done', { task_id: 't2' }), conversation);
  await flush();
  assert.deepEqual(calls, [{ taskId: 't2', conversationId: 'c1', status: 'done', title: '任务完成', body: conversation.title }]);
});

test('fresh tasks finishing between polls notify; first-seen undated history does not', async () => {
  const { calls, tracker } = fixture();
  tracker.observe(task('failed', { completed_at: 1001, error: 'secret-token' }), conversation);
  tracker.observe(task('failed', { task_id: 'old' }), conversation);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '任务失败');
  assert.ok(!JSON.stringify(calls).includes('secret-token'));
});

test('camelCase task details, multiple sources and pending requests share deduplication', async () => {
  let release;
  const calls = [];
  const { tracker } = fixture((item) => {
    calls.push(item);
    return new Promise((resolve) => { release = resolve; });
  });
  tracker.observe({ taskId: 't1', conversationId: 'c1', status: 'queued' });
  tracker.observe({ taskId: 't1', conversationId: 'c1', status: 'failed' });
  await flush();
  tracker.observe(task('failed'), conversation);
  await flush();
  assert.equal(calls.length, 1);
  release();
  await flush();
  tracker.observe(task('failed'), conversation);
  await flush();
  assert.equal(calls.length, 1);
});

test('scheduling failures can retry without throwing into task handling', async () => {
  let attempts = 0;
  const { tracker } = fixture(() => {
    if (++attempts === 1) throw new Error('native scheduling failed');
  });
  tracker.observe(task('running'), conversation);
  tracker.observe(task('failed'), conversation);
  await flush();
  tracker.observe(task('failed'), conversation);
  await flush();
  assert.equal(attempts, 2);
});

test('disposed sessions cannot notify after sign-out, missing identities are ignored', async () => {
  const { calls, tracker } = fixture();
  tracker.observe({ status: 'done', completed_at: 1001 }, conversation);
  tracker.observe(task('done', { completed_at: 1001 }));
  tracker.observe(task('running'), conversation);
  tracker.observe(task('done'), conversation);
  tracker.dispose();
  await flush();
  tracker.observe(task('failed'), conversation);
  await flush();
  assert.deepEqual(calls, []);
});

test('web notification initialization is a no-op', () => {
  const cleanup = startTaskNotifications('device', () => assert.fail('web must not notify'));
  cleanup();
});

test('native bridge waits for permission, scopes taps and cleans up', async () => {
  let grant;
  let action;
  let removed = false;
  const calls = [];
  const opened = [];
  const native = {
    requestPermissions: () => new Promise((resolve) => { grant = resolve; }),
    schedule: async (item) => calls.push(item),
    addListener: async (_name, callback) => {
      action = callback;
      return { remove: () => { removed = true; } };
    },
  };
  const cleanup = startTaskNotifications('device-a', (id) => opened.push(id), { native });
  observeNotificationTask(task('running'), conversation);
  observeNotificationTask(task('done'), conversation);
  await flush();
  assert.deepEqual(calls, []);
  grant({ granted: true });
  await flush();
  assert.equal(calls[0].scope, 'device-a');
  action({ scope: 'other-device', conversationId: 'wrong' });
  action({ scope: 'device-a', conversationId: 'c1' });
  assert.deepEqual(opened, ['c1']);
  cleanup();
  await flush();
  assert.equal(removed, true);
  action({ scope: 'device-a', conversationId: 'late' });
  assert.deepEqual(opened, ['c1']);
});

test('permission denial and sign-out during the prompt never schedule notifications', async () => {
  for (const signOut of [false, true]) {
    let grant;
    let count = 0;
    const native = {
      requestPermissions: () => new Promise((resolve) => { grant = resolve; }),
      schedule: async () => { count += 1; },
      addListener: async () => ({ remove() {} }),
    };
    const cleanup = startTaskNotifications('device', () => {}, { native });
    observeNotificationTask(task('running'), conversation);
    observeNotificationTask(task('failed'), conversation);
    await flush();
    if (signOut) cleanup();
    grant({ granted: signOut });
    await flush();
    assert.equal(count, 0);
    cleanup();
  }
});

test('native notifications are linked, routed, use AppIcon and retain cold-start taps', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const swift = read('ios/App/App/TaskNotificationsPlugin.swift');
  assert.match(swift, /notificationRouter\.localNotificationHandler = self/);
  assert.match(swift, /return \[\.banner, \.list, \.sound\]/);
  assert.match(swift, /retainUntilConsumed: true/);
  assert.match(swift, /UserDefaults\.standard\.set/);
  assert.match(swift, /SHA256\.hash/);
  assert.doesNotMatch(swift, /UNNotificationAttachment|registerForRemoteNotifications/);
  assert.match(read('ios/App/App/AppDelegate.swift'), /_ = TaskNotifications\.self/);
  assert.match(read('ios/App/App.xcodeproj/project.pbxproj'), /TaskNotificationsPlugin\.swift in Sources/);
  const app = read('src/App.jsx');
  assert.match(app, /observeNotificationConversation\(nextConversation\)/);
  assert.match(app, /nextConversations\.forEach\(observeNotificationConversation\)/);
  assert.match(app, /observeNotificationTask\(state,/);
});
