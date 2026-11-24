// LeadScout — API key metadata (pure logic, no chrome.* APIs).
//
// Chrome/Edge do not expose a provider's key-expiry date: Groq, Gemini,
// OpenRouter and Hunter keys do not publish one. So "expiry" here is an
// explicit rotation date the user sets, plus the date the key was saved and
// the last successful check. The UI never invents a provider expiry.

export const KEY_PROVIDERS = ['groq', 'gemini', 'openrouter', 'custom', 'hunter'];

export const KEY_LABELS = {
  groq: 'Groq',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  custom: 'Custom endpoint',
  hunter: 'Hunter.io'
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function emptyKeyMeta() {
  const out = {};
  for (const p of KEY_PROVIDERS) {
    out[p] = { savedAt: '', expiresAt: '', lastCheckedAt: '', lastCheckOk: null };
  }
  return out;
}

export function isDateStr(value) {
  const m = DATE_RE.exec(String(value || ''));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** Local calendar date as YYYY-MM-DD (never UTC — the user sees local dates). */
export function localDateStr(now = Date.now()) {
  const d = new Date(now);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Merge stored metadata with the full schema; invalid values are dropped. */
export function normalizeKeyMeta(raw) {
  const out = emptyKeyMeta();
  if (!raw || typeof raw !== 'object') return out;
  for (const p of KEY_PROVIDERS) {
    const m = raw[p];
    if (!m || typeof m !== 'object') continue;
    if (isDateStr(m.savedAt)) out[p].savedAt = m.savedAt;
    if (isDateStr(m.expiresAt)) out[p].expiresAt = m.expiresAt;
    if (isDateStr(m.lastCheckedAt)) out[p].lastCheckedAt = m.lastCheckedAt;
    if (typeof m.lastCheckOk === 'boolean') out[p].lastCheckOk = m.lastCheckOk;
  }
  return out;
}

/** Whole calendar days from today to the expiry date (0 = today, -1 = yesterday). */
export function daysLeft(expiresAt, now = Date.now()) {
  if (!isDateStr(expiresAt)) return null;
  const [y, m, d] = String(expiresAt).split('-').map(Number);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export function fmtDate(dateStr) {
  if (!isDateStr(dateStr)) return '';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d + ' ' + months[m - 1] + ' ' + y;
}

/**
 * Status for one key's expiry date.
 * state: none (no date set) | active (>30d) | soon (<=30d) | expired
 */
export function keyStatus(meta, now = Date.now()) {
  const expiresAt = meta && isDateStr(meta.expiresAt) ? meta.expiresAt : '';
  if (!expiresAt) {
    return { state: 'none', daysLeft: null, expiresAt: '', label: 'No expiry set' };
  }
  const days = daysLeft(expiresAt, now);
  if (days === null) {
    return { state: 'none', daysLeft: null, expiresAt: '', label: 'No expiry set' };
  }
  if (days < 0) {
    const n = Math.abs(days);
    return {
      state: 'expired', daysLeft: days, expiresAt,
      label: 'Expired ' + n + ' day' + (n === 1 ? '' : 's') + ' ago'
    };
  }
  if (days === 0) return { state: 'soon', daysLeft: 0, expiresAt, label: 'Expires today' };
  if (days <= 30) {
    return {
      state: 'soon', daysLeft: days, expiresAt,
      label: 'Expires in ' + days + ' day' + (days === 1 ? '' : 's')
    };
  }
  return { state: 'active', daysLeft: days, expiresAt, label: 'Expires ' + fmtDate(expiresAt) };
}

/** Safe display mask — never render the full secret in the UI. */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '…' + s.slice(-4);
}
