// UI messages must never expose transport diagnostics or upstream response text.
export function userErrorMessage(error) {
  const status = error?.status == null ? undefined : Number(error.status);
  if (status === 404) return 'This conversation is no longer available. Refresh your task list.';
  if (status === 401 || status === 403) return 'Please reconnect to Haish.';
  if (status === 409) return 'This task has changed. Refresh and try again.';
  if (status === 429) return 'Too many requests. Please try again shortly.';
  if (status >= 500) return 'Haish is temporarily unavailable. Please try again.';
  if (error?.requestDiagnostic?.stage === 'timeout' || status === 0) return 'Connection timed out. Please try again.';
  return 'Could not complete the request. Please try again.';
}
