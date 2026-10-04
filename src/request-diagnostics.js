// Metadata only: never retain request headers/bodies, response bodies, pairing
// addresses, URL queries (image paths/cursors), or arbitrary exception text.
export const REQUEST_DIAGNOSTICS_KEY = 'haish_remote_request_diagnostics_v1';
export const REQUEST_DIAGNOSTICS_LIMIT = 30;
let sequence = 0;
let recent = [];

function storage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function readRequestDiagnostics() {
  try {
    const saved = JSON.parse(storage()?.getItem(REQUEST_DIAGNOSTICS_KEY) || 'null');
    if (Array.isArray(saved)) return saved.slice(-REQUEST_DIAGNOSTICS_LIMIT);
  } catch { /* Storage may be unavailable or full on a device. */ }
  return recent.slice();
}

function safePath(path) {
  const route = String(path || '').split(/[?#]/, 1)[0];
  return /^\/(api|remote)\/[\w/%.-]+$/.test(route) ? route.slice(0, 240) : '(invalid route)';
}

function safeType(value, fallback) {
  const text = String(value || '');
  return /^[\w.-]{1,60}$/.test(text) ? text : fallback;
}

function nativeMessage(error) {
  // JSON.parse exceptions often quote the response payload; only retain known
  // browser messages. HTTP details and event-handler errors can contain user data.
  const message = String(error?.message || '');
  return /^(The string did not match the expected pattern\.|Load failed|Failed to fetch|Network request failed|The operation was aborted\.|Aborted)$/.test(message)
    ? message : '';
}

export function diagnoseRequestError(error, context) {
  if (error?.requestDiagnostic) return error;
  const stage = safeType(error?.failureStage || context.stage, 'unknown');
  const type = safeType(error?.name, 'Error');
  const time = new Date().toISOString();
  const record = {
    id: `req-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    time,
    method: safeType(context.method || 'GET', 'GET'),
    path: safePath(context.path),
    stage,
    type,
    status: Number.isInteger(context.response?.status) ? context.response.status : null,
    elapsedMs: Math.max(0, Date.now() - context.startedAt),
    contentType: String(context.response?.headers?.get('content-type') || '').split(';')[0]
      .replace(/[^\w/+.-]/g, '').slice(0, 80),
    message: nativeMessage(error),
  };
  if (Number.isInteger(context.responseChars)) record.responseChars = context.responseChars;
  if (Number.isInteger(error?.streamLine)) record.streamLine = error.streamLine;
  recent = [...readRequestDiagnostics(), record].slice(-REQUEST_DIAGNOSTICS_LIMIT);
  try { storage()?.setItem(REQUEST_DIAGNOSTICS_KEY, JSON.stringify(recent)); } catch { /* Best effort. */ }
  console.warn('[Haish request failure]', record);

  const summary = stage === 'http' ? String(error?.message || 'Request failed.')
    : stage === 'timeout' ? 'Connection timed out. Make sure Haish is running on your computer.'
    : record.message || ({
      'build-url': 'Could not construct the request address.',
      fetch: 'Network request failed.',
      'json-read': 'Could not read the response body.',
      'json-parse': 'Invalid JSON response.',
      'blob-read': 'Could not read the image response.',
      'stream-open': 'Could not open the task stream.',
      'stream-read': 'Task stream interrupted.',
      'stream-parse': 'Invalid JSON in the task stream.',
      'stream-handler': 'Could not process a task event.',
    }[stage] || 'Request processing failed.');
  const details = [
    `${record.method} ${record.path}`, stage, type,
    record.status === null ? 'no HTTP response' : `HTTP ${record.status}`,
    record.contentType || '',
    record.responseChars === undefined ? '' : `${record.responseChars} chars`,
    record.streamLine === undefined ? '' : `line ${record.streamLine}`,
    `${record.elapsedMs}ms`, record.time, record.id,
  ].filter(Boolean).join(' · ');
  const next = new Error(`${summary} [${details}]`, { cause: error });
  next.status = stage === 'timeout' ? 0 : error?.status ?? record.status ?? undefined;
  next.requestDiagnostic = record;
  return next;
}

// Attach the failing stream stage without copying payload-bearing parser text.
export function streamFailure(error, stage, line) {
  const next = new Error('Task stream failure.', { cause: error });
  next.name = error?.name || 'Error';
  next.failureStage = stage;
  next.streamLine = line;
  // Only known native messages are safe to propagate into persistent diagnostics.
  next.message = nativeMessage(error) || next.message;
  return next;
}
