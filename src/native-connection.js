import { Capacitor } from '@capacitor/core';
import {
  KeychainAccess,
  SecureStorage,
} from '@aparajita/capacitor-secure-storage';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { parsePairingUri, validateStoredConnection } from './pairing-uri.js';

const CONNECTION_KEY = 'connection';
let connection = null;
let storageReady;

export const isNativeApp = Capacitor.isNativePlatform();

async function prepareStorage() {
  if (!isNativeApp) return;
  storageReady ||= (async () => {
    await SecureStorage.setKeyPrefix('haish_remote_');
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  })();
  await storageReady;
}

export async function initializeNativeConnection() {
  if (!isNativeApp) return null;
  await prepareStorage();
  const stored = validateStoredConnection(await SecureStorage.get(CONNECTION_KEY));
  if (!stored) {
    await SecureStorage.remove(CONNECTION_KEY);
    connection = null;
    return null;
  }
  connection = stored;
  return connection;
}

export function currentNativeConnection() {
  return connection;
}

export async function saveNativeConnection(endpoint, token) {
  if (!isNativeApp) return;
  await prepareStorage();
  const next = validateStoredConnection({ endpoint, token });
  if (!next) throw new Error('The computer returned an invalid device credential.');
  await SecureStorage.set(CONNECTION_KEY, next);
  connection = next;
}

export async function clearNativeConnection() {
  if (!isNativeApp) return;
  await prepareStorage();
  await SecureStorage.remove(CONNECTION_KEY);
  connection = null;
}

export async function scanPairingCode() {
  if (!isNativeApp) throw new Error('QR pairing is only available in the Haish mobile app.');
  const result = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
    scanOrientation: CapacitorBarcodeScannerScanOrientation.PORTRAIT,
    scanInstructions: 'Scan the QR code shown by Haish on your computer',
    scanButton: false,
    cancelButtonAccessibilityLabel: 'Cancel pairing',
    torchButtonOnAccessibilityLabel: 'Turn flashlight off',
    torchButtonOffAccessibilityLabel: 'Turn flashlight on',
  });
  return parsePairingUri(result.ScanResult);
}

export function requestContext(path, endpoint) {
  if (!isNativeApp) return { url: path, credentials: 'include', token: '' };
  const target = endpoint || connection?.endpoint;
  if (!target) throw new Error('Scan the QR code shown by Haish on your computer.');
  return {
    url: new URL(path, `${target}/`).toString(),
    credentials: 'omit',
    token: endpoint ? '' : connection?.token || '',
  };
}
