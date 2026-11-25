// LeadScout — the Troubleshoot panel, shared by every extension page.
//
// A page hands over two things: `gather()` returns the facts diagnose() needs,
// and `fixes` maps a fix id to the function that performs it. The panel builds
// all of its own DOM and styles, so it looks and behaves the same everywhere
// and cannot depend on a page element that another build may not have.

import { diagnose, headline, reportText, FIX_LABELS, LEVEL_LABELS } from './diagnose.js';
import { CRM_EXPORT_HEADERS } from './parse.js';

const PANEL_ID = 'ls-troubleshoot';
const STYLE_ID = 'ls-troubleshoot-style';

const MARKS = { fail: '!', warn: '•', info: 'i', ok: '✓' };

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (!child) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style', { id: STYLE_ID, type: 'text/css' });
  style.textContent = `
.ls-ts{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
  font:13px/1.5 "Segoe UI",system-ui,Arial,sans-serif;color:#E7E9F2;text-align:left}
.ls-ts,.ls-ts *{box-sizing:border-box}
.ls-ts-backdrop{position:absolute;inset:0;background:rgba(5,6,12,.74);backdrop-filter:blur(4px)}
.ls-ts-card{position:relative;display:flex;flex-direction:column;width:min(600px,calc(100% - 16px));
  max-height:calc(100% - 16px);background:#12152A;border:1px solid rgba(165,180,252,.28);border-radius:16px;
  box-shadow:0 24px 60px rgba(0,0,0,.55);overflow:hidden}
.ls-ts-head{display:flex;gap:12px;align-items:flex-start;padding:16px 16px 12px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.ls-ts-badge{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;
  font-size:17px;font-weight:800;background:var(--c);color:#0B0D17}
.ls-ts-badge.ok{--c:#34D399}.ls-ts-badge.warn{--c:#FBBF24}.ls-ts-badge.fail{--c:#F87171}
.ls-ts-title{margin:0;font-size:17px;font-weight:800;letter-spacing:.2px}
.ls-ts-headline{margin:1px 0 0;font-size:12.5px;color:#AEB4CC}
.ls-ts-close{margin-left:auto;flex:none;width:30px;height:30px;border-radius:9px;cursor:pointer;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#E7E9F2;font-size:14px}
.ls-ts-close:hover{background:rgba(255,255,255,.16)}
.ls-ts-body{overflow:auto;padding:10px 16px 14px}
.ls-ts-contract{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 12px}
.ls-ts-col{font:600 10.5px Consolas,"Cascadia Mono",monospace;padding:3px 8px;border-radius:999px;
  background:rgba(99,102,241,.16);color:#C7D2FE;border:1px solid rgba(99,102,241,.34)}
.ls-ts-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.ls-ts-item{display:flex;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.08);border-left:3px solid var(--c)}
.ls-ts-item.fail{--c:#F87171}.ls-ts-item.warn{--c:#FBBF24}.ls-ts-item.info{--c:#60A5FA}.ls-ts-item.ok{--c:#34D399}
.ls-ts-mark{flex:none;width:20px;height:20px;margin-top:1px;border-radius:50%;display:grid;place-items:center;
  font-size:11px;font-weight:800;background:var(--c);color:#0B0D17}
.ls-ts-item h3{margin:0 0 2px;font-size:13.2px;font-weight:700;color:#F1F3FB}
.ls-ts-item p{margin:0;font-size:12.4px;color:#BEC4DC}
.ls-ts-fix{display:inline-block;margin-top:9px;padding:6px 12px;border-radius:9px;cursor:pointer;
  border:none;background:linear-gradient(135deg,#4F46E5,#9333EA);color:#fff;font:600 12px "Segoe UI",Arial,sans-serif}
.ls-ts-fix:hover{filter:brightness(1.12)}
.ls-ts-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center;
  padding:10px 16px;border-top:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.2)}
.ls-ts-status{margin-right:auto;font-size:12px;color:#34D399}
.ls-ts-status.err{color:#FBBF24}
.ls-ts-btn{padding:7px 13px;border-radius:9px;cursor:pointer;font:600 12.3px "Segoe UI",Arial,sans-serif;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#E7E9F2}
.ls-ts-btn:hover{background:rgba(255,255,255,.16)}
.ls-ts-report{width:100%;height:120px;margin-top:8px;resize:vertical;font:11.5px Consolas,monospace;
  background:#0B0D17;color:#D5DAEE;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px}
.ls-ts-empty{padding:26px 12px;text-align:center;color:#AEB4CC}
[data-theme="light"] .ls-ts-card{background:#FFFFFF;color:#171A2B;border-color:rgba(99,102,241,.3)}
[data-theme="light"] .ls-ts-headline,[data-theme="light"] .ls-ts-empty{color:#5D6378}
[data-theme="light"] .ls-ts-item{background:#F6F7FD;border-color:#E4E6F0}
[data-theme="light"] .ls-ts-item h3{color:#171A2B}
[data-theme="light"] .ls-ts-item p{color:#3D4358}
[data-theme="light"] .ls-ts-close,[data-theme="light"] .ls-ts-btn{color:#171A2B;background:#F1F2FA;
  border-color:#D9DCEA}
[data-theme="light"] .ls-ts-foot{background:#F6F7FD}
[data-theme="light"] .ls-ts-col{color:#4338CA;background:rgba(99,102,241,.1)}
`;
  document.head.appendChild(style);
}

export function isTroubleshootOpen() {
  return !!document.getElementById(PANEL_ID);
}

export function closeTroubleshoot() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
}

/**
 * Open (or refresh) the panel.
 * @param {{gather: () => Promise<object>, fixes: Object<string, () => any>}} options
 */
export function openTroubleshoot(options) {
  const { gather, fixes = {} } = options || {};
  if (typeof gather !== 'function') return;
  ensureStyle();
  closeTroubleshoot();

  const badge = el('div', { class: 'ls-ts-badge', 'aria-hidden': 'true' });
  const title = el('h2', { class: 'ls-ts-title', id: 'ls-ts-title', text: 'Troubleshoot' });
  const lead = el('p', { class: 'ls-ts-headline', text: 'Checking the extension and the CSV export…' });
  const body = el('div', { class: 'ls-ts-body' });
  const status = el('span', { class: 'ls-ts-status' });
  const foot = el('div', { class: 'ls-ts-foot' });

  const close = el('button', { class: 'ls-ts-close', type: 'button', title: 'Close (Esc)',
    'aria-label': 'Close troubleshooting' }, '✕');
  close.addEventListener('click', closeTroubleshoot);

  const panel = el('div', { id: PANEL_ID, class: 'ls-ts', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'ls-ts-title' }, [
    el('div', { class: 'ls-ts-backdrop' }),
    el('div', { class: 'ls-ts-card' }, [
      el('div', { class: 'ls-ts-head' }, [badge, el('div', {}, [title, lead]), close]),
      body, foot
    ])
  ]);
  panel.querySelector('.ls-ts-backdrop').addEventListener('click', closeTroubleshoot);
  document.body.appendChild(panel);

  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeTroubleshoot(); }
  };
  document.addEventListener('keydown', onKey);

  let last = null;
  let lastFacts = null;

  function render(result) {
    if (!document.getElementById(PANEL_ID)) { document.removeEventListener('keydown', onKey); return; }
    last = result;
    badge.className = 'ls-ts-badge ' + result.level;
    badge.textContent = MARKS[result.level];
    lead.textContent = headline(result);
    body.replaceChildren();

    const chips = el('div', { class: 'ls-ts-contract', 'aria-label': 'The 10 CSV columns, in order' },
      CRM_EXPORT_HEADERS.map(h => el('span', { class: 'ls-ts-col', text: h })));
    body.appendChild(chips);

    const list = el('ol', { class: 'ls-ts-list' });
    for (const item of result.findings) {
      const text = el('div', {}, [
        el('h3', { text: item.title }),
        item.detail ? el('p', { text: item.detail }) : null
      ]);
      const run = typeof fixes[item.fix] === 'function' ? fixes[item.fix] : null;
      if (run) {
        const button = el('button', { class: 'ls-ts-fix', type: 'button',
          'data-fix': item.fix, text: FIX_LABELS[item.fix] || 'Fix' });
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Working…';
          status.className = 'ls-ts-status';
          status.textContent = '';
          try {
            await run();
          } catch (e) {
            status.className = 'ls-ts-status err';
            status.textContent = 'That fix did not complete: ' + String((e && e.message) || e);
            button.disabled = false;
            button.textContent = FIX_LABELS[item.fix];
            return;
          }
          // These two reload the page itself, so there is nothing left to refresh.
          if (item.fix === 'reload-page' || item.fix === 'reload-extension') return;
          setTimeout(() => refresh(), 500);
        });
        text.appendChild(button);
      }
      list.appendChild(el('li', { class: 'ls-ts-item ' + item.level, 'data-finding': item.id }, [
        el('span', { class: 'ls-ts-mark', 'aria-hidden': 'true', text: MARKS[item.level] }),
        text
      ]));
    }
    if (!result.findings.length) body.appendChild(el('div', { class: 'ls-ts-empty', text: 'Nothing to report.' }));
    body.appendChild(list);
  }

  function renderFoot() {
    foot.replaceChildren(status);
    const again = el('button', { class: 'ls-ts-btn', type: 'button', text: '↻ Check again' });
    again.addEventListener('click', () => refresh());
    const copy = el('button', { class: 'ls-ts-btn', type: 'button', text: '📋 Copy report' });
    copy.addEventListener('click', async () => {
      if (!last) return;
      const text = reportText(last, lastFacts);
      try {
        await navigator.clipboard.writeText(text);
        status.className = 'ls-ts-status';
        status.textContent = '✓ Report copied — paste it anywhere';
      } catch (e) {
        // Clipboard blocked (common when the window loses focus): show the text instead.
        status.className = 'ls-ts-status err';
        status.textContent = 'Clipboard blocked — select and copy the text below';
        foot.appendChild(el('textarea', { class: 'ls-ts-report', 'aria-label': 'Troubleshooting report',
          readonly: true }, text));
      }
    });
    foot.appendChild(again);
    foot.appendChild(copy);
  }

  async function refresh() {
    status.className = 'ls-ts-status';
    status.textContent = 'Checking…';
    body.replaceChildren(el('div', { class: 'ls-ts-empty', text: 'Checking…' }));
    try {
      const facts = await gather();
      if (!document.getElementById(PANEL_ID)) return;
      lastFacts = facts;
      render(diagnose(facts));
      status.textContent = '';
    } catch (e) {
      if (!document.getElementById(PANEL_ID)) return;
      render(diagnose({ guardError: 'The check itself failed: ' + String((e && e.message) || e) }));
      status.className = 'ls-ts-status err';
      status.textContent = 'The check did not finish — use Check again';
    }
    if (document.getElementById(PANEL_ID)) renderFoot();
  }

  renderFoot();
  close.focus();
  refresh();
}
