// LeadScout — side panel workspace controller.
//
// The panel owns the table; the service worker owns page access and searching.
// Every value here comes from an extraction, a lookup, or the user's own typing.
// Nothing is generated to fill a cell.

import {
  RECORD_FIELDS, RESOLVE_STATUS, emptyRecord, normalizeRecord, mergeRecords,
  recordsToCSV, recordsToTSV, needsResolution, verifySearchUrl, parseSelectionText,
  isBlankRecord
} from './lib/records.js';

import { installGuard, on, onInput } from './lib/ui-guard.js';
installGuard('sidepanel');
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'workspace.rows';
const PENDING_KEY = 'workspacePending';
const MAX_ROWS = 1000;

const state = { rows: [], search: '', resolving: false, armed: false };

// ------------------------------------------------------------------ utils --

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), isError ? 4200 : 2200);
}

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clean = state.rows
      .filter(r => !isBlankRecord(r))
      .slice(0, MAX_ROWS)
      .map(({ id, ...rest }) => rest);
    chrome.storage.local.set({ [STORE_KEY]: clean });
  }, 220);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function withIds(list) {
  return list.map(r => ({ ...r, id: crypto.randomUUID() }));
}

function visibleRows() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.rows;
  return state.rows.filter(r =>
    [r.firstName, r.lastName, r.company, r.designation, r.email, r.country, r.industry, r.linkedinUrl]
      .join(' ').toLowerCase().includes(q));
}

// ------------------------------------------------------------------ stats --

function refreshStats(sourceLabel) {
  const missing = state.rows.filter(needsResolution).length;
  $('chipRows').innerHTML = 'Rows <b>' + state.rows.length + '</b>';
  const chip = $('chipMissing');
  chip.innerHTML = 'Missing LinkedIn <b>' + missing + '</b>';
  chip.classList.toggle('warn', missing > 0);
  chip.classList.toggle('ok', state.rows.length > 0 && missing === 0);
  if (sourceLabel) $('chipSource').innerHTML = 'Source <b>' + sourceLabel + '</b>';
  $('btnResolve').disabled = missing === 0 || state.resolving;
}

function setProgress(done, total) {
  const bar = $('progress');
  if (!total) { bar.classList.remove('on'); return; }
  bar.classList.add('on');
  const pct = Math.round((done / total) * 100);
  $('progressBar').style.width = pct + '%';
  bar.setAttribute('aria-valuenow', String(pct));
  bar.title = done + ' / ' + total + ' resolved';
}

// ----------------------------------------------------------------- render --

function cellFor(row, field) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.contentEditable = 'true';
  cell.spellcheck = false;
  cell.dataset.field = field;
  cell.dataset.empty = row[field] ? 'false' : 'true';
  cell.textContent = row[field] || '';
  cell.setAttribute('aria-label', field);

  cell.addEventListener('input', () => {
    row[field] = cell.textContent.trim();
    cell.dataset.empty = row[field] ? 'false' : 'true';
    persist();
    refreshStats();
  });

  cell.addEventListener('blur', () => {
    const before = row[field];
    if (field === 'linkedinUrl') {
      const fixed = normalizeRecord({ linkedinUrl: before }).linkedinUrl;
      row[field] = fixed;
      if (fixed && !row.status) row.status = 'direct';
    } else if (field === 'website') {
      row[field] = normalizeRecord({ website: before }).website;
    } else {
      row[field] = String(before || '').trim();
    }
    if (row[field] !== before) {
      cell.textContent = row[field];
      cell.dataset.empty = row[field] ? 'false' : 'true';
      persist();
      refreshStats();
      renderRowBadge(row);
    }
  });

  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
  });

  return cell;
}

function renderRowBadge(row) {
  const holder = document.querySelector('[data-badge="' + row.id + '"]');
  if (!holder) return;
  holder.innerHTML = '';
  const status = row.status;
  if (status && RESOLVE_STATUS[status]) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + status;
    badge.textContent = RESOLVE_STATUS[status];
    holder.appendChild(badge);
  } else if (!row.linkedinUrl && (row.firstName || row.lastName) && verifySearchUrl(row)) {
    const link = document.createElement('a');
    link.className = 'badge review';
    link.textContent = 'Verify';
    link.href = verifySearchUrl(row);
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Open a search to find this person yourself';
    holder.appendChild(link);
  }
}

function linkIcon(href, title, glyph) {
  const a = document.createElement('a');
  a.className = 'icon' + (href ? '' : ' off');
  a.href = href || '#';
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = title;
  a.textContent = glyph;
  return a;
}

function render() {
  const tbody = $('tbody');
  tbody.innerHTML = '';
  const rows = visibleRows();
  $('empty').style.display = state.rows.length ? 'none' : 'block';
  if (!state.rows.length) {
    $('empty').querySelector('h2').textContent = 'No prospects yet';
    $('empty').querySelector('p').textContent = 'Open a LinkedIn profile, a people-search page or a company team page and press Extract current page. You can also select text, right-click and choose "Extract prospect to LeadScout", or add a row by hand.';
  } else if (!rows.length) {
    $('empty').style.display = 'block';
    $('empty').querySelector('h2').textContent = 'No rows match this filter';
    $('empty').querySelector('p').textContent = 'Clear the filter box to see all ' + state.rows.length + ' rows.';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;

    for (const field of ['firstName', 'lastName', 'designation', 'email', 'company', 'companySize', 'country', 'industry']) {
      const td = document.createElement('td');
      td.appendChild(cellFor(row, field));
      tr.appendChild(td);
    }

    const siteTd = document.createElement('td');
    const siteWrap = document.createElement('div');
    siteWrap.className = 'linkcell';
    siteWrap.appendChild(cellFor(row, 'website'));
    siteWrap.appendChild(linkIcon(row.website ? 'https://' + row.website : '', 'Open website', '↗'));
    siteTd.appendChild(siteWrap);
    tr.appendChild(siteTd);

    const liTd = document.createElement('td');
    const liWrap = document.createElement('div');
    liWrap.className = 'linkcell';
    const inner = document.createElement('div');
    inner.style.flex = '1 1 auto';
    inner.style.minWidth = '0';
    inner.appendChild(cellFor(row, 'linkedinUrl'));
    const badgeHolder = document.createElement('div');
    badgeHolder.dataset.badge = row.id;
    inner.appendChild(badgeHolder);
    liWrap.appendChild(inner);
    const liLink = linkIcon(row.linkedinUrl || '', 'Open LinkedIn profile', 'in');
    liWrap.appendChild(liLink);
    liTd.appendChild(liWrap);
    tr.appendChild(liTd);

    const actionTd = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'rowdel';
    del.type = 'button';
    del.title = 'Delete this row';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      state.rows = state.rows.filter(r => r.id !== row.id);
      persist(); refreshStats(); render();
    });
    actionTd.appendChild(del);
    tr.appendChild(actionTd);

    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  // Badges were written before the rows existed in the DOM; fill them now.
  for (const row of rows) renderRowBadge(row);
}

// --------------------------------------------------------------- actions ---

async function extractCurrentPage() {
  const btn = $('btnExtract');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '⌖ Reading page…';
  try {
    const res = await send({ type: 'workspace:extract' });
    if (!res.ok) { toast(res.error || 'Could not read this page', true); return; }
    let incoming = res.rows || [];
    if (res.context === 'selection' && res.selection) {
      incoming = parseSelectionText(res.selection);
      if (!incoming.length) { toast('No parsable prospect in the selection', true); return; }
    }
    if (!incoming.length) {
      toast('No prospects found on this page — try a profile, list or team page', true);
      return;
    }
    applyIncoming(incoming, res);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function applyIncoming(incoming, meta = {}) {
  const merged = mergeRecords(state.rows, incoming);
  state.rows = withIds(merged.rows);
  persist();
  refreshStats(meta.context || 'page');
  render();
  const bits = [];
  if (merged.added) bits.push(merged.added + ' added');
  if (merged.updated) bits.push(merged.updated + ' filled');
  toast((bits.join(' · ') || 'No new rows') + ' — ' + state.rows.length + ' total');
}

async function resolveMissing() {
  if (state.resolving) return;
  const targets = state.rows.filter(r => needsResolution(r) && (r.firstName || r.lastName));
  if (!targets.length) { toast('Every row already has a LinkedIn URL'); return; }
  state.resolving = true;
  $('btnResolve').disabled = true;
  $('btnResolve').textContent = '↯ Resolving…';
  setProgress(0, targets.length);
  let done = 0, resolved = 0, review = 0;
  try {
    for (const row of targets) {
      const res = await send({ type: 'workspace:resolve', record: row });
      done++;
      setProgress(done, targets.length);
      if (res.ok) {
        if (res.url) { row.linkedinUrl = res.url; row.status = 'auto'; resolved++; }
        else { row.status = 'review'; review++; }
        renderRowBadge(row);
      }
      if (res.ok && (res.state === 'captcha' || res.state === 'consent')) {
        toast('Bing needs a human check — finish it in the Bing tab, then run Resolve again', true);
        break;
      }
    }
  } finally {
    state.resolving = false;
    $('btnResolve').textContent = '↯ Resolve missing';
    persist();
    refreshStats();
    render();
    setProgress(0, 0);
    if (done) toast(resolved + ' resolved · ' + review + ' need a look');
  }
}

function exportCSV() {
  const rows = visibleRows();
  if (!rows.length) { toast('Nothing to export', true); return; }
  const csv = '\uFEFF' + recordsToCSV(rows);
  download('leadscout-workspace-' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
  toast('CSV exported — ' + rows.length + ' rows, 10 columns');
}

async function copyTSV() {
  const rows = visibleRows();
  if (!rows.length) { toast('Nothing to copy', true); return; }
  try {
    await navigator.clipboard.writeText(recordsToTSV(rows));
    toast('TSV copied — paste into Sheets or Excel');
  } catch (e) {
    toast('Clipboard blocked — use the CSV download', true);
  }
}

function addRow() {
  const row = { ...emptyRecord(), id: crypto.randomUUID() };
  state.rows.push(row);
  render();
  persist();
  refreshStats();
  const cell = document.querySelector('tr[data-id="' + row.id + '"] .cell');
  if (cell) { cell.focus(); }
  $('tableWrap').scrollTop = $('tableWrap').scrollHeight;
}

function armClear(btn) {
  if (!state.armed) {
    state.armed = true;
    btn.classList.add('armed');
    btn.textContent = '✕ Click to confirm';
    clearTimeout(armClear._t);
    armClear._t = setTimeout(() => {
      state.armed = false;
      btn.classList.remove('armed');
      btn.textContent = '✕ Clear';
    }, 3200);
    return;
  }
  clearTimeout(armClear._t);
  state.armed = false;
  btn.classList.remove('armed');
  btn.textContent = '✕ Clear';
  state.rows = [];
  persist();
  refreshStats('—');
  render();
  toast('Table cleared');
}

// ---------------------------------------------------------------- wiring ---

async function load() {
  const st = await chrome.storage.local.get([STORE_KEY, PENDING_KEY]);
  state.rows = withIds(((st[STORE_KEY] || []).filter(r => r && !isBlankRecord(r))).map(normalizeRecord));
  refreshStats();
  render();
  if (st[PENDING_KEY]) await consumePending(st[PENDING_KEY]);
}

async function consumePending(pending) {
  await chrome.storage.local.remove(PENDING_KEY);
  if (!pending) return;
  let incoming = pending.rows || [];
  if (pending.selectionText || pending.context === 'selection') {
    const text = pending.selectionText || pending.selection || '';
    const parsed = parseSelectionText(text);
    if (parsed.length) incoming = incoming.concat(parsed);
  }
  if (!incoming.length) { toast('Nothing parsable in that selection', true); return; }
  applyIncoming(incoming, { context: pending.context || 'capture' });
}

on('btnExtract', extractCurrentPage);
on('btnResolve', resolveMissing);
on('btnAdd', addRow);
on('btnCsv', exportCSV);
on('btnTsv', copyTSV);
on('btnClear', () => armClear($('btnClear')));

onInput('search', (e) => {
  state.search = e.target.value;
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PENDING_KEY]) return;
  const pending = changes[PENDING_KEY].newValue;
  if (pending) consumePending(pending);
});

load();
