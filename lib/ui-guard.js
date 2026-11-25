// LeadScout — visible failure guard.
//
// A thrown error during page wiring used to leave a blank panel with no clue.
// This turns any uncaught error or rejected promise into a readable banner, and
// gives pages a safe way to bind buttons that may be missing from a stale build.

const BANNER_ID = 'ls-guard-banner';

function banner() {
  let el = document.getElementById(BANNER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'left:8px', 'right:8px', 'bottom:8px', 'z-index:2147483647',
    'padding:10px 12px', 'border-radius:10px', 'font:12px/1.45 "Segoe UI",Arial,sans-serif',
    'background:#3b0d12', 'color:#fecaca', 'border:1px solid #b91c1c',
    'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'white-space:pre-wrap', 'word-break:break-word'
  ].join(';');
  document.body.appendChild(el);
  return el;
}

function report(label, message) {
  const text = 'LeadScout ' + label + ' error: ' + String(message || 'unknown error');
  try {
    const el = banner();
    el.textContent = text + '  (copy this message if you report it)';
  } catch (e) { /* nothing else we can do */ }
  try { console.error('[LeadScout]', text); } catch (e) { /* ignore */ }
}

/**
 * Bind a click handler without letting one missing element kill the page.
 * Returns true when the element existed.
 */
export function on(id, handler, eventName = 'click') {
  // Imported under Node (tests/link-check) there is no DOM: skip quietly.
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(id);
  if (!el) {
    try { console.warn('[LeadScout] missing element #' + id + ' — skipped'); } catch (e) { /* ignore */ }
    return false;
  }
  el.addEventListener(eventName, handler);
  return true;
}

/** Convenience wrappers so the event name is never forgotten. */
export function onInput(id, handler) { return on(id, handler, 'input'); }
export function onChange(id, handler) { return on(id, handler, 'change'); }

/** Install once per page, before any wiring runs. */
export function installGuard(label) {
  if (typeof window === 'undefined') return;
  if (window.__lsGuard) return;
  window.__lsGuard = true;
  window.addEventListener('error', (e) => {
    report(label, (e && e.message) || 'script failed to load');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    report(label, (reason && reason.message) || reason || 'promise rejected');
  });
}
