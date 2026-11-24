// LeadScout — tiny cross-browser helpers (Chrome, Microsoft Edge, Brave, Opera).
// No chrome.* access at import time so the module stays unit-testable.

export function browserName(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  const s = String(ua || '');
  if (/Edg\//.test(s)) return 'Microsoft Edge';
  if (/OPR\//.test(s)) return 'Opera';
  if (/Brave/i.test(s)) return 'Brave';
  if (/Chrome\//.test(s)) return 'Google Chrome';
  if (/Chromium\//.test(s)) return 'Chromium';
  return 'Chromium browser';
}

/** True only when this page runs inside an installed extension context. */
export function extensionContextOk() {
  return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
}

/** Browser-specific extensions page used in recovery instructions. */
export function extensionsUrl(ua) {
  return /Edge/i.test(browserName(ua)) ? 'edge://extensions' : 'chrome://extensions';
}
