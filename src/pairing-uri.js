export const PAIRING_URI_VERSION = '1';

function parseHttpsOrigin(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('The QR code contains an invalid remote address.');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error('The QR code must contain a secure HTTPS origin.');
  }
  return endpoint.origin;
}

export function parsePairingUri(value) {
  let uri;
  try {
    uri = new URL(String(value || '').trim());
  } catch {
    throw new Error('This is not a Haish pairing QR code.');
  }
  if (uri.protocol !== 'haish:' || uri.hostname !== 'pair' || uri.pathname !== '') {
    throw new Error('This is not a Haish pairing QR code.');
  }
  if (uri.searchParams.get('v') !== PAIRING_URI_VERSION) {
    throw new Error('This Haish pairing QR code version is not supported.');
  }
  const allowedKeys = new Set(['v', 'endpoint', 'code']);
  const keys = [...uri.searchParams.keys()];
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error('The QR code contains unsupported or duplicate fields.');
  }
  const code = uri.searchParams.get('code') || '';
  if (!/^\d{8}$/.test(code)) {
    throw new Error('The QR code contains an invalid pairing code.');
  }
  return {
    endpoint: parseHttpsOrigin(uri.searchParams.get('endpoint') || ''),
    code,
  };
}

export function validateStoredConnection(value) {
  if (!value || typeof value !== 'object') return null;
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  if (token.length < 32) return null;
  try {
    return { endpoint: parseHttpsOrigin(value.endpoint), token };
  } catch {
    return null;
  }
}
