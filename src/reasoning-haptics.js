import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './native-connection.js';

export const NATIVE_REASONING_HAPTICS = 'ReasoningHaptics';
export const REASONING_HAPTIC_STYLES = ['light', 'medium', 'heavy', 'rigid'];

let reasoningHaptics;

export function nativeReasoningHaptics() {
  if (!isNativeApp) return null;
  if (!reasoningHaptics) reasoningHaptics = registerPlugin(NATIVE_REASONING_HAPTICS);
  return reasoningHaptics;
}

/**
 * One native impact for one discrete reasoning step. Higher steps intentionally use stronger
 * UIKit feedback styles; browsers remain silent because vibration is part of the iOS affordance.
 */
export async function impactReasoningStep(index) {
  const plugin = nativeReasoningHaptics();
  if (!plugin) return false;
  const step = Math.max(0, Math.min(REASONING_HAPTIC_STYLES.length - 1, Math.floor(Number(index) || 0)));
  await plugin.impact({ style: REASONING_HAPTIC_STYLES[step], step });
  return true;
}
