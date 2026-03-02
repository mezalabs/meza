/**
 * Biometric app lock — Signal-style behavior.
 *
 * - Enabled via settings toggle
 * - On enable: stores masterKey in expo-secure-store
 * - On background: starts 30-second grace period
 * - If app resumes within 30s: no biometric prompt
 * - If timer expires or app killed: require biometric on next open
 * - Fallback to password after 3 failed attempts
 */

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { AppState, type AppStateStatus } from 'react-native';

const LOCK_ENABLED_KEY = 'meza_biometric_lock_enabled';
const MASTER_KEY_SECURE_KEY = 'meza_master_key';
const GRACE_PERIOD_MS = 30_000;

let backgroundTimestamp: number | null = null;
let isLocked = false;
let lockListeners: Array<(locked: boolean) => void> = [];

/**
 * Subscribe to lock state changes.
 */
export function onLockStateChange(
  listener: (locked: boolean) => void,
): () => void {
  lockListeners.push(listener);
  return () => {
    lockListeners = lockListeners.filter((l) => l !== listener);
  };
}

function notifyListeners() {
  for (const listener of lockListeners) {
    listener(isLocked);
  }
}

export function getIsLocked(): boolean {
  return isLocked;
}

/**
 * Check if biometric lock is enabled.
 */
export async function isBiometricLockEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(LOCK_ENABLED_KEY);
  return val === 'true';
}

/**
 * Enable biometric lock and store the master key securely.
 */
export async function enableBiometricLock(
  masterKey: Uint8Array,
): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return false;

  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  if (!isEnrolled) return false;

  // Store master key in secure store (protected by device biometrics)
  const hex = Array.from(masterKey, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(MASTER_KEY_SECURE_KEY, hex, {
    requireAuthentication: true,
  });
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'true');
  return true;
}

/**
 * Disable biometric lock and clear the stored master key.
 */
export async function disableBiometricLock(): Promise<void> {
  await SecureStore.deleteItemAsync(MASTER_KEY_SECURE_KEY);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'false');
  isLocked = false;
  notifyListeners();
}

/**
 * Attempt biometric authentication to unlock the app.
 * Returns the stored master key on success, or null on failure.
 */
export async function authenticateAndUnlock(): Promise<Uint8Array | null> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock Meza',
    fallbackLabel: 'Use password',
    disableDeviceFallback: false,
  });

  if (!result.success) return null;

  // Retrieve master key from secure store
  const hex = await SecureStore.getItemAsync(MASTER_KEY_SECURE_KEY);
  if (!hex) return null;

  isLocked = false;
  notifyListeners();

  // Convert hex back to Uint8Array
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Initialize the biometric lock app state listener.
 * Call once at app startup.
 */
export async function initBiometricLock(): Promise<void> {
  const enabled = await isBiometricLockEnabled();
  if (!enabled) return;

  // Start locked on cold start
  isLocked = true;
  notifyListeners();

  AppState.addEventListener('change', handleAppStateChange);
}

function handleAppStateChange(nextState: AppStateStatus) {
  if (nextState === 'background' || nextState === 'inactive') {
    // Record when we went to background
    backgroundTimestamp = Date.now();
  } else if (nextState === 'active') {
    if (backgroundTimestamp !== null) {
      const elapsed = Date.now() - backgroundTimestamp;
      backgroundTimestamp = null;

      if (elapsed > GRACE_PERIOD_MS) {
        // Grace period expired — require biometric
        isBiometricLockEnabled().then((enabled) => {
          if (enabled) {
            isLocked = true;
            notifyListeners();
          }
        });
      }
    }
  }
}
