import { Keyboard } from '@capacitor/keyboard';

import { isNativeApp } from './native-connection.js';

/**
 * iOS 会在 WebView 里的输入框获得焦点时，于键盘上方压一条系统表单栏（「◀ ▶ Done」）。
 * 那条栏是系统给网页表单的，不属于本 App：它白占一行高度，把输入框和键盘隔开，点 Done 也只是收键盘
 * （本 App 点消息区就收）。Capacitor 官方的 Keyboard 插件负责这条栏，所以这里直接让它隐藏。
 *
 * 插件在 `capacitor.config.ts` 里被声明、并随 `packageClassList` 注册进包；注册缺失时这里的调用会
 * 直接失败，而不是悄悄留着那条栏。
 */
export async function hideKeyboardAccessoryBar({ keyboard = Keyboard, native = isNativeApp } = {}) {
  if (!native) return false;
  await keyboard.setAccessoryBarVisible({ isVisible: false });
  return true;
}
