import { Capacitor, registerPlugin } from '@capacitor/core';
import { createTaskNotificationTracker } from './task-notification-policy.js';

export const NATIVE_TASK_NOTIFICATIONS = 'TaskNotifications';
let plugin;
let session = null;

function nativePlugin() {
  if (Capacitor.getPlatform() !== 'ios') return null;
  plugin ||= registerPlugin(NATIVE_TASK_NOTIFICATIONS);
  return plugin;
}

export function startTaskNotifications(scope, onOpen, { native = nativePlugin(), barkEnabled = false } = {}) {
  if (!native || !scope) return () => {};
  const permission = barkEnabled ? Promise.resolve({ granted: false }) : native.requestPermissions().catch(() => ({ granted: false }));
  if (barkEnabled) native.clearLocalNotifications?.().catch(() => {});
  const tracker = createTaskNotificationTracker({
    notify: async (notification) => {
      const { granted } = await permission;
      if (granted && session === tracker) return native.schedule({ ...notification, scope });
      return false;
    },
  });
  session = tracker;
  // Denied permission must never block pairing or task execution. iOS only prompts once;
  // subsequent launches read the existing decision through requestAuthorization.
  const listener = native.addListener('taskNotificationAction', (event) => {
    if (session === tracker && event.scope === scope && event.conversationId) onOpen(event.conversationId);
  }).catch(() => null);
  const barkListener = native.addListener('barkNotificationAction', (event) => {
    if (session === tracker && event.scope === scope && event.conversationId) onOpen(event.conversationId);
  }).catch(() => null);
  return () => {
    barkListener.then((handle) => handle?.remove()).catch(() => {});
    tracker.dispose();
    if (session === tracker) session = null;
    listener.then((handle) => handle?.remove()).catch(() => {});
  };
}

export function observeNotificationTask(task, conversation) {
  session?.observe(task, conversation);
}

export function observeNotificationConversation(conversation) {
  for (const task of conversation?.tasks || []) observeNotificationTask(task, conversation);
}
