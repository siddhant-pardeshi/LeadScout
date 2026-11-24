// LeadScout — popup controller (part 1: helpers, state, progress)

import { DEFAULT_SETTINGS, parseInputs, buildCSV, fmtEta,
  splitProspectName, linkedinUrlForExport, websiteNameForExport } from './lib/parse.js';
import { KEY_PROVIDERS, KEY_LABELS, normalizeKeyMeta, keyStatus, fmtDate, localDateStr, isDateStr } from './lib/keys.js';
import { extensionContextOk, extensionsUrl } from './lib/platform.js';
import { extractLinkedInCompany } from './lib/extract.js';

const $ = (id) => document.getElementById(id);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const keyInputId = (p) => 'setKey' + cap(p);
const keyExpId = (p) => 'setExp' + cap(p);
const keyStatusId = (p) => 'keyStatus' + cap(p);

let settings = { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } };
let job = null;
const ui = { filter: 'all', search: '', pollTimer: null };
const clearArm = { provider: '', timer: null };

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

function flashButton(id) {
  const b = $(id);
  if (!b) return;
  b.classList.remove('flash');
  void b.offsetWidth; // restart the animation
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 650);
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'no response' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

// v1.4.1: the service worker may still be registering right after the
// extension loads/reloads — one retry turns that race into a clean success.
const SW_COLD_RE = /receiving end does not exist|could not establish connection|message port closed/i;
async function sendMsgRetry(msg) {
  const first = await sendMsg(msg);
  if (first.ok || !SW_COLD_RE.test(String(first.error || ''))) return first;
  await new Promise(r => setTimeout(r, 700));
  return sendMsg(msg);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes());
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function loadState() {
  const st = await chrome.storage.local.get(['settings', 'job']);
  if (st.settings) {
    settings = { ...DEFAULT_SETTINGS, ...st.settings,
      keys: { ...DEFAULT_SETTINGS.keys, ...(st.settings.keys || {}) },
      keyMeta: normalizeKeyMeta(st.settings.keyMeta) };
  }
  job = st.job || null;
}

function startPolling() {
  if (ui.pollTimer) return;
  ui.pollTimer = setInterval(refresh, 800);
}

function stopPolling() {
  if (ui.pollTimer) { clearInterval(ui.pollTimer); ui.pollTimer = null; }
}

async function refresh() {
  const st = await chrome.storage.local.get(['job']);
  job = st.job || job;
  renderProgress();
  renderResults(false);
  if (!job || (!job.running && !job.paused)) stopPolling();
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || 'dark';
}

function updateInputCount() {
  const items = parseInputs($('companyInput').value);
  $('inputCount').textContent = items.length +
    (items.length === 1 ? ' company' : ' companies');
  return items;
}

function currentProviderKeyReady() {
  const prov = $('optProvider').value;
  if (prov === 'none') return { ready: true };
  if (prov === 'custom') {
    if (settings.customBase && settings.keys && settings.keys.custom) return { ready: true };
    return {
      ready: false,
      hint: 'Custom endpoint needs both a base URL and an API key — add them in Settings (gear icon).'
    };
  }
  const key = (settings.keys && settings.keys[prov]) || '';
  if (key) return { ready: true };
  return {
    ready: false,
    hint: 'No ' + prov + ' API key saved yet — add one in Settings (gear icon), or pick "None (Bing only)".'
  };
}

// ---------------------------------------------------- progress rendering ----

function renderProgress() {
  if (!job) return;
  const hasActivity = job.running || job.paused || (job.queue && job.queue.length);
  const card = $('cardProgress');
  card.classList.toggle('hidden', !hasActivity);
  if (!hasActivity) return;

  const total = job.queue ? job.queue.length : 0;
  const done = (job.queue || []).filter(q => q.status === 'done' || q.status === 'failed').length;
  $('progCount').textContent = done + ' / ' + total;
  $('progBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';

  let label = 'Idle';
  if (job.attention) label = 'Needs attention';
  else if (job.paused) label = 'Paused';
  else if (job.running) {
    const cur = (job.queue || [])[job.cursor];
    label = cur && cur.status === 'working'
      ? ('Researching: ' + (cur.name || cur.input))
      : 'Working…';
  } else if (job.finishedAt) label = 'Finished';
  $('progLabel').textContent = label;

  const remaining = Math.max(0, total - done);
  const etaSec = job.perCompanyMs ? (remaining * job.perCompanyMs) / 1000 : 0;
  $('progEta').textContent = (job.running && remaining > 0)
    ? ('ETA ' + fmtEta(etaSec)) : 'ETA —';

  // live stat tiles
  let peopleN = 0, verifiedN = 0;
  for (const c of (job.results || [])) {
    for (const p of (c.people || [])) {
      peopleN++;
      if (p.urlVerified) verifiedN++;
    }
  }
  $('statPeople').textContent = String(peopleN);
  $('statVerified').textContent = String(verifiedN);
  $('statCompanies').textContent = String(done);
  $('statRemaining').textContent = String(remaining);

  const banner = $('attentionBanner');
  if (job.attention) {
    banner.textContent = '⚠ ' + job.attention;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const doneB = $('doneBanner');
  if (!job.running && !job.paused && job.finishedAt && total > 0) {
    doneB.textContent = '✓ Finished — ' + done + ' of ' + total +
      ' companies · ' + peopleN + ' people (' + verifiedN + ' verified). Export below.';
    doneB.classList.remove('hidden');
  } else {
    doneB.classList.add('hidden');
  }

  renderQueueChips();
  syncProgressButtons();
}

function renderQueueChips() {
  const ql = $('queueList');
  const queue = (job && job.queue) || [];
  if (!queue.length) { ql.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  for (const q of queue) {
    const el = document.createElement('span');
    el.className = 'q-item ' + (q.status || 'queued');
    let txt = (q.name || q.input || '').slice(0, 26);
    if (q.status === 'done') txt += ' ✓';
    if (q.status === 'failed') txt += ' ✗';
    el.textContent = txt;
    el.title = (q.name || q.input || '') + (q.error ? ' — ' + q.error : '');
    frag.appendChild(el);
  }
  ql.replaceChildren(frag);
}

function syncProgressButtons() {
  const running = !!(job && job.running);
  const paused = !!(job && job.paused);
  $('btnPause').classList.toggle('hidden', !running || paused);
  $('btnResume').classList.toggle('hidden', !paused);
  $('btnStop').classList.toggle('hidden', !running && !paused);
  const failed = !!(job && job.queue && job.queue.some(q => q.status === 'failed'));
  $('btnRetryFailed').classList.toggle('hidden', !(failed && !running && !paused));
  // v1.4: fresh-data re-run of everything already researched
  const doneN = job && job.queue ? job.queue.filter(q => q.status === 'done').length : 0;
  $('btnRefreshAll').classList.toggle('hidden', !(doneN > 0 && !running && !paused));
}

// ----------------------------------------------------- results rendering ----

function flattenRows() {
  const rows = [];
  if (!job || !job.results) return rows;
  for (const comp of job.results) {
    const people = [...(comp.people || [])].sort((a, b) =>
      (a.pri || 9) - (b.pri || 9) || (b.score || 0) - (a.score || 0));
    if (!people.length) {
      rows.push({ comp: comp, p: null, kind: 'review' });
      continue;
    }
    for (const p of people) rows.push({ comp: comp, p: p, kind: 'person' });
  }
  return rows;
}

function rowMatches(r, filter, search) {
  const cat = r.p ? r.p.cat : 'review';
  if (filter === 'unverified') {
    if (r.kind !== 'person') return false;
    if (r.p.urlVerified || r.p.sourceType === 'official') return false;
  } else if (filter === 'review') {
    if (r.kind !== 'review') return false;
  } else if (filter !== 'all') {
    if (r.kind !== 'person' || cat !== filter) return false;
  }
  if (search) {
    const hay = ((r.p ? r.p.name + ' ' + r.p.designation : '') +
      ' ' + r.comp.name + ' ' + r.comp.industry).toLowerCase();
    if (hay.indexOf(search.toLowerCase()) === -1) return false;
  }
  return true;
}

function companyCell(comp) {
  const td = tdText(comp.name || comp.input || '', 'co');
  if (comp.url) {
    const link = linkEl(comp.url, '↗');
    if (link.tagName === 'A') {
      link.className = 'co-link';
      link.title = 'Company LinkedIn page';
    }
    td.appendChild(document.createTextNode(' '));
    td.appendChild(link);
  }
  return td;
}

function linkEl(href, txt) {
  // v1.4 security: only real web links become anchors — never javascript:/data:
  if (!/^https?:\/\//i.test(String(href || ''))) {
    return document.createTextNode(txt);
  }
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = txt;
  return a;
}

function tdText(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function reviewDisplay(comp) {
  const code = comp.outcome || (comp.status === 'failed' ? 'search_error' : 'no_public_match');
  const defaults = {
    search_blocked: ['SEARCH BLOCKED', 'Bing needs attention before research can continue'],
    source_blocked: ['SOURCE BLOCKED', 'Company website blocked automated access'],
    source_error: ['SOURCE ERROR', 'Company website pages could not be read'],
    search_error: ['SEARCH ERROR', 'Search results could not be read'],
    no_profile_results: ['NO PROFILES', 'No matching LinkedIn profiles were returned by Bing'],
    candidates_rejected: ['REVIEW', 'Profile candidates did not pass company/current-role checks'],
    no_public_match: ['REVIEW', 'No evidence-backed decision-maker was found']
  };
  const pair = defaults[code] || defaults.no_public_match;
  return {
    pill: pair[0], text: comp.reviewReason || pair[1],
    title: comp.reviewDetail || comp.error || '',
    cls: code === 'search_blocked' || code === 'search_error' || code === 'source_blocked' || code === 'source_error' ? 'est' : 'u'
  };
}

// v1.4 lag fix: the table is expensive to rebuild — only re-render when the
// underlying data actually changed (poll runs every 800 ms).
let lastResultsKey = '';

function renderResults(force) {
  if (!job) return;
  const hasResults = !!(job.results && job.results.length);
  $('cardResults').classList.toggle('hidden', !hasResults);
  if (!hasResults) { lastResultsKey = ''; return; }

  let doneN = 0, peopleN = 0;
  for (const c of job.results) {
    if (c.status === 'done') doneN++;
    peopleN += (c.people || []).length;
  }
  const key = doneN + '|' + peopleN + '|' + (job.finishedAt || 0) + '|' + (job.updatedAt || 0);
  if (!force && key === lastResultsKey) return;
  lastResultsKey = key;

  const rows = flattenRows();
  const peopleCount = rows.filter(r => r.kind === 'person').length;
  const verifiedCount = rows.filter(r => r.kind === 'person' && r.p.urlVerified).length;
  $('resSummary').textContent = peopleCount + ' people · ' + verifiedCount + ' verified';

  const visible = rows.filter(r => rowMatches(r, ui.filter, ui.search)).slice(0, 300);
  const tbody = $('resBody');
  const frag = document.createDocumentFragment();
  for (const r of visible) {
    const tr = document.createElement('tr');

    if (r.kind === 'review') {
      const review = reviewDisplay(r.comp);
      tr.appendChild(tdText('—', 'ds'));
      tr.appendChild(tdText('—', 'ds'));
      const reason = tdText(review.text, 'ds');
      reason.title = review.title;
      tr.appendChild(reason);
      tr.appendChild(tdText('—', 'ds'));
      tr.appendChild(companyCell(r.comp));
      tr.appendChild(tdText(r.comp.size || '', 'ds'));
      tr.appendChild(tdText(r.comp.country || '', 'ds'));
      tr.appendChild(tdText(r.comp.industry || '', 'ds'));
      tr.appendChild(tdText(websiteNameForExport(r.comp.website), 'ds'));
      tr.appendChild(tdText('—', 'ds'));
      frag.appendChild(tr);
      continue;
    }

    const p = r.p;
    const c = r.comp;
    const name = splitProspectName(p.name);

    tr.appendChild(tdText(name.firstName, 'nm'));
    tr.appendChild(tdText(name.lastName, 'nm'));

    const tdD = document.createElement('td');
    tdD.className = 'ds';
    tdD.textContent = p.designation || '';
    tr.appendChild(tdD);

    const tdE = document.createElement('td');
    tdE.className = 'est-mail';
    if (p.email) {
      tdE.textContent = p.email;
      tdE.title = p.emailStatus || 'Email status unavailable';
    } else {
      tdE.textContent = '—';
    }
    tr.appendChild(tdE);

    const tdCo = companyCell(c);
    if (c.aiNote) tdCo.title = c.aiNote;
    tr.appendChild(tdCo);

    tr.appendChild(tdText(c.size || '', 'ds'));
    tr.appendChild(tdText(c.country || '', 'ds'));
    tr.appendChild(tdText(c.industry || '', 'ds'));
    tr.appendChild(tdText(websiteNameForExport(c.website), 'ds'));

    const profileUrl = linkedinUrlForExport(p.url);
    const tdL = document.createElement('td');
    if (profileUrl) tdL.appendChild(linkEl(profileUrl, 'profile'));
    else tdL.appendChild(document.createTextNode('—'));
    tr.appendChild(tdL);

    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

// -------------------------------------------------------------- actions ----

async function doStart() {
  const items = updateInputCount();
  if (!items.length) {
    toast('Paste at least one LinkedIn URL or company name');
    return;
  }
  const prov = $('optProvider').value;
  const keyCheck = currentProviderKeyReady();
  if (!keyCheck.ready) {
    toast(keyCheck.hint, 3200);
    return;
  }

  settings.scanMode = $('optMode').value;
  settings.provider = prov;
  settings.deepScan = $('optDeepScan').checked;
  settings.includeEmails = $('optEmails').checked;
  await sendMsgRetry({ type: 'setSettings', settings: settings });

  const res = await sendMsgRetry({ type: 'start', items: items });
  if (!res.ok) {
    toast('Start failed: ' + String(res.error || 'unknown'), 3200);
    return;
  }
  toast('Researching ' + res.count + ' companies…');
  await loadState();
  renderProgress();
  renderResults(true);
  startPolling();
}

async function doPause() {
  await sendMsg({ type: 'pause' });
  await loadState();
  renderProgress();
  syncProgressButtons();
}

async function doResume() {
  await sendMsg({ type: 'resume' });
  await loadState();
  renderProgress();
  syncProgressButtons();
  startPolling();
}

async function doStop() {
  await sendMsg({ type: 'stop' });
  await loadState();
  renderProgress();
  syncProgressButtons();
}

async function doRetryFailed() {
  if (!job || !job.queue) return;
  const failed = job.queue.filter(q => q.status === 'failed');
  if (!failed.length) return;
  const requeued = failed.map(q => ({
    type: q.type, slug: q.slug, name: q.name, input: q.input,
    status: 'queued', error: ''
  }));
  await sendMsgRetry({ type: 'start', items: requeued });
  toast('Retrying ' + requeued.length + ' failed companies');
  await loadState();
  startPolling();
}

// v1.4: re-run every researched company so names, roles, facts and emails
// reflect the latest public data (results entries are updated in place).
async function doRefreshAll() {
  if (!job || !job.queue) return;
  const done = job.queue.filter(q => q.status === 'done');
  if (!done.length) return;
  const requeued = done.map(q => ({
    type: q.type, slug: q.slug, name: q.name, input: q.input,
    status: 'queued', error: ''
  }));
  await sendMsgRetry({ type: 'start', items: requeued });
  toast('Refreshing ' + requeued.length + ' companies with latest data…');
  await loadState();
  startPolling();
}

async function doClearResults() {
  await sendMsg({ type: 'clearResults' });
  await loadState();
  renderProgress();
  renderResults(true);
  toast('Results cleared');
}

async function doAddCurrent() {
  const res = await sendMsg({ type: 'addCurrentPage' });
  if (!res.ok) {
    toast(res.error || 'Could not read the current tab', 2600);
    return;
  }
  const ta = $('companyInput');
  const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.indexOf(res.line) !== -1) {
    toast('Already in the list');
    return;
  }
  ta.value = lines.concat([res.line]).join('\n');
  updateInputCount();
  toast('Added current company');
}

function doSample() {
  $('companyInput').value =
    'https://www.linkedin.com/company/zoho/\n' +
    'Freshworks\n' +
    'Postman - https://www.linkedin.com/company/postman-platform/';
  updateInputCount();
}

// -------------------------------------------------------------- exports ----

function exportTargets() {
  return ((job && job.results) || []).filter(c => c.status === 'done');
}

function hasAcceptedProspects(comps) {
  return comps.some(c => (c.people || []).length > 0);
}

/**
 * v1.3 one-click exports: when a filter chip or search is active, export ONLY
 * the visible rows (grouped back by company). Otherwise export everything.
 */
function filteredExportComps() {
  const comps = exportTargets();
  const filtering = (ui.filter !== 'all') || !!ui.search;
  if (!filtering) return comps;
  const rows = flattenRows().filter(r => rowMatches(r, ui.filter, ui.search));
  const map = new Map();
  for (const r of rows) {
    const c = map.get(r.comp.id);
    if (c) {
      if (r.kind === 'person') c.people.push(r.p);
      else c.hasReview = true;
    } else {
      map.set(r.comp.id, {
        id: r.comp.id,
        input: r.comp.input,
        url: r.comp.url,
        name: r.comp.name,
        industry: r.comp.industry,
        size: r.comp.size,
        hq: r.comp.hq,
        country: r.comp.country,
        website: r.comp.website,
        outcome: r.comp.outcome,
        reviewReason: r.comp.reviewReason,
        reviewDetail: r.comp.reviewDetail,
        people: r.kind === 'person' ? [r.p] : [],
        hasReview: r.kind !== 'person'
      });
    }
  }
  const out = [];
  for (const c of map.values()) {
    if (c.people.length || c.hasReview) out.push(c);
  }
  return out;
}

async function doCopy() {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet'); return; }
  if (!hasAcceptedProspects(comps)) { toast('No accepted prospects in the current view'); return; }
  const csv = buildCSV(comps);
  try {
    await navigator.clipboard.writeText(csv);
    flashButton('btnCopyCsv');
    toast('Copied the 10-column CSV');
  } catch (e) {
    toast('Clipboard blocked — use the .CSV download instead');
  }
}

function doDownload() {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet'); return; }
  if (!hasAcceptedProspects(comps)) { toast('No accepted prospects in the current view'); return; }
  // BOM first so Excel reads the UTF-8 names correctly
  download('leadscout-' + stamp() + '.csv',
    '\uFEFF' + buildCSV(comps),
    'text/csv;charset=utf-8');
  flashButton('btnDlCsv');
  toast('CSV saved — opens straight in Excel');
}

// ------------------------------------------------------------- settings ----

function shortExpiry(st) {
  if (st.state === 'none') return 'no expiry';
  if (st.state === 'expired') return 'expired ' + fmtDate(st.expiresAt).replace(/ \d{4}$/, '');
  if (st.daysLeft === 0) return 'expires today';
  if (st.state === 'soon') return 'expires ' + fmtDate(st.expiresAt).replace(/ \d{4}$/, '');
  return 'expires ' + fmtDate(st.expiresAt);
}

function renderKeyStatus(provider) {
  const el = $(keyStatusId(provider));
  if (!el) return;
  const key = (settings.keys && settings.keys[provider]) || '';
  const meta = normalizeKeyMeta(settings.keyMeta)[provider];
  if (!key) {
    el.textContent = 'not saved';
    el.className = 'key-status none';
    el.title = 'No key saved yet';
    return;
  }
  const st = keyStatus(meta);
  el.textContent = 'saved · ' + shortExpiry(st);
  el.className = 'key-status ' + st.state;
  let title = 'Saved ' + (meta.savedAt ? fmtDate(meta.savedAt) : '(date not recorded)');
  if (st.expiresAt) title += ' · Expires ' + fmtDate(st.expiresAt) + ' (' + st.label + ')';
  else title += ' · No expiry date set (providers do not publish one)';
  if (meta.lastCheckedAt) {
    title += ' · Last checked ' + fmtDate(meta.lastCheckedAt) + (meta.lastCheckOk ? ' ✓' : ' ✗');
  }
  el.title = title;
}

function renderKeyWarnings() {
  const banner = $('keyBanner');
  if (!banner) return;
  const meta = normalizeKeyMeta(settings.keyMeta);
  const keys = settings.keys || {};
  const issues = [];
  for (const p of KEY_PROVIDERS) {
    if (!keys[p]) continue;
    const st = keyStatus(meta[p]);
    if (st.state === 'expired') {
      issues.push(KEY_LABELS[p] + ' key expired');
    } else if (st.state === 'soon') {
      issues.push(KEY_LABELS[p] + ' key ' + st.label.toLowerCase() +
        (st.expiresAt ? ' (' + fmtDate(st.expiresAt) + ')' : ''));
    }
  }
  if (!issues.length) {
    banner.classList.add('hidden');
    banner.onclick = null;
    return;
  }
  banner.textContent = '⚠ ' + issues.join(' · ') + ' — click to update in Settings.';
  banner.classList.remove('hidden');
  banner.onclick = openSettings;
}

function applyKeyVisibility() {
  const show = !!($('showKeys') && $('showKeys').checked);
  document.querySelectorAll('.key-input').forEach((el) => {
    el.type = show ? 'text' : 'password';
  });
}

function collectFormSettings() {
  const keys = { ...(settings.keys || {}) };
  const meta = normalizeKeyMeta(settings.keyMeta);
  for (const p of KEY_PROVIDERS) {
    const input = $(keyInputId(p));
    if (!input) continue;
    const val = input.value.trim();
    // A blank field means "keep the saved key", never "delete it".
    if (val && val !== (keys[p] || '')) {
      keys[p] = val;
      meta[p].savedAt = localDateStr();
      meta[p].lastCheckedAt = '';
      meta[p].lastCheckOk = null;
    }
    const exp = $(keyExpId(p));
    meta[p].expiresAt = exp && isDateStr(exp.value) ? exp.value : '';
  }
  return {
    ...settings,
    provider: $('setProvider').value,
    keys,
    keyMeta: meta,
    models: {
      groq: $('setModelGroq').value.trim(),
      gemini: $('setModelGemini').value.trim(),
      openrouter: $('setModelOpenrouter').value.trim(),
      custom: ''
    },
    customBase: $('setCustomBase').value.trim(),
    customModel: $('setCustomModel').value.trim(),
    bingDelayMs: Number($('setDelay').value) || 2200,
    searchHost: $('setHost').value,
    theme: $('setTheme').value
  };
}

async function persistKey(provider, opts = {}) {
  const label = KEY_LABELS[provider] || provider;
  const input = $(keyInputId(provider));
  const raw = input ? input.value.trim() : '';
  if (!raw) {
    if (!opts.silent) toast('Paste a ' + label + ' key first');
    return false;
  }
  const keys = { ...(settings.keys || {}) };
  const meta = normalizeKeyMeta(settings.keyMeta);
  const changed = raw !== (keys[provider] || '');
  keys[provider] = raw;
  if (changed || !meta[provider].savedAt) {
    meta[provider].savedAt = localDateStr();
    meta[provider].lastCheckedAt = '';
    meta[provider].lastCheckOk = null;
  }
  const exp = $(keyExpId(provider));
  meta[provider].expiresAt = exp && isDateStr(exp.value) ? exp.value : '';
  const next = { ...settings, keys, keyMeta: meta };
  const res = await sendMsgRetry({ type: 'setSettings', settings: next });
  if (!res.ok) {
    toast('Could not save ' + label + ' key: ' + String(res.error || 'unknown'), 3200);
    return false;
  }
  settings = next;
  renderKeyStatus(provider);
  renderKeyWarnings();
  if (!opts.silent) toast(label + ' key saved permanently on this device');
  return true;
}

async function clearKey(provider) {
  const label = KEY_LABELS[provider] || provider;
  if (!(settings.keys && settings.keys[provider])) {
    toast('No ' + label + ' key saved');
    return;
  }
  const btn = document.querySelector('[data-key-clear="' + provider + '"]');
  if (clearArm.provider !== provider) {
    clearTimeout(clearArm.timer);
    document.querySelectorAll('[data-key-clear]').forEach((b) => {
      b.textContent = '✕';
      b.title = 'Remove saved key';
    });
    clearArm.provider = provider;
    clearArm.timer = setTimeout(() => {
      clearArm.provider = '';
      if (btn) { btn.textContent = '✕'; btn.title = 'Remove saved key'; }
    }, 3000);
    if (btn) { btn.textContent = '?'; btn.title = 'Click again to remove'; }
    toast('Click ✕ again to remove the ' + label + ' key', 2600);
    return;
  }
  clearTimeout(clearArm.timer);
  clearArm.provider = '';
  if (btn) { btn.textContent = '✕'; btn.title = 'Remove saved key'; }
  const keys = { ...(settings.keys || {}), [provider]: '' };
  const meta = normalizeKeyMeta(settings.keyMeta);
  meta[provider] = { savedAt: '', expiresAt: '', lastCheckedAt: '', lastCheckOk: null };
  const next = { ...settings, keys, keyMeta: meta };
  const res = await sendMsgRetry({ type: 'setSettings', settings: next });
  if (!res.ok) {
    toast('Could not clear ' + label + ' key: ' + String(res.error || 'unknown'), 3200);
    return;
  }
  settings = next;
  const input = $(keyInputId(provider));
  if (input) input.value = '';
  const exp = $(keyExpId(provider));
  if (exp) exp.value = '';
  renderKeyStatus(provider);
  renderKeyWarnings();
  toast(label + ' key removed');
}

function openSettings() {
  $('setProvider').value = settings.provider || 'groq';
  settings.keyMeta = normalizeKeyMeta(settings.keyMeta);
  for (const p of KEY_PROVIDERS) {
    $(keyInputId(p)).value = (settings.keys && settings.keys[p]) || '';
    $(keyExpId(p)).value = settings.keyMeta[p].expiresAt || '';
    renderKeyStatus(p);
  }
  $('showKeys').checked = false;
  applyKeyVisibility();
  const models = settings.models || {};
  $('setModelGroq').value = models.groq || '';
  $('setModelGemini').value = models.gemini || '';
  $('setModelOpenrouter').value = models.openrouter || '';
  $('setCustomBase').value = settings.customBase || '';
  $('setCustomModel').value = settings.customModel || '';
  $('setDelay').value = settings.bingDelayMs || 2200;
  $('delayVal').textContent = (settings.bingDelayMs || 2200) + ' ms';
  $('setHost').value = settings.searchHost || 'www.bing.com';
  $('setTheme').value = settings.theme || 'dark';
  $('customFields').classList.toggle('hidden', $('setProvider').value !== 'custom');
  $('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const next = collectFormSettings();
  const provider = next.provider;

  if (provider === 'custom' && next.customBase) {
    try {
      const origin = new URL(next.customBase).origin + '/*';
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        toast('Permission denied for custom endpoint', 3000);
        return;
      }
    } catch (e) {
      toast('Invalid custom base URL', 3000);
      return;
    }
  }

  const res = await sendMsgRetry({ type: 'setSettings', settings: next });
  if (!res.ok) {
    toast('Save failed: ' + String(res.error || 'unknown'), 3000);
    return;
  }
  settings = next;
  applyTheme();
  renderKeyWarnings();
  $('settingsModal').classList.add('hidden');
  toast('Settings saved');
}

async function testKey() {
  const el = $('testResult');
  const provider = $('setProvider').value;
  if (provider === 'none') {
    el.textContent = 'Pick an AI provider first';
    el.className = 'test-result err';
    return;
  }
  const input = $(keyInputId(provider));
  if (input && input.value.trim() && input.value.trim() !== ((settings.keys || {})[provider] || '')) {
    const saved = await persistKey(provider, { silent: true });
    if (!saved) return;
  }
  el.textContent = 'Testing…';
  el.className = 'test-result';
  const res = await sendMsgRetry({ type: 'testAI', provider });
  const meta = normalizeKeyMeta(settings.keyMeta);
  meta[provider].lastCheckedAt = localDateStr();
  meta[provider].lastCheckOk = !!res.ok;
  const stored = await sendMsgRetry({ type: 'setSettings', settings: { ...settings, keyMeta: meta } });
  if (stored.ok) settings.keyMeta = meta;
  renderKeyStatus(provider);
  renderKeyWarnings();
  if (res.ok) {
    el.textContent = '✓ ' + res.message;
    el.classList.add('ok');
  } else {
    el.textContent = '✗ ' + String(res.error || 'failed');
    el.classList.add('err');
  }
}

// ----------------------------------------------------------------- wire ----

function wire() {
  $('companyInput').addEventListener('input', updateInputCount);
  $('btnStart').addEventListener('click', doStart);
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      doStart();
    }
  });
  $('btnAddCurrent').addEventListener('click', doAddCurrent);
  $('btnSample').addEventListener('click', doSample);
  $('btnClearInput').addEventListener('click', () => {
    $('companyInput').value = '';
    updateInputCount();
  });

  $('btnPause').addEventListener('click', doPause);
  $('btnResume').addEventListener('click', doResume);
  $('btnStop').addEventListener('click', doStop);
  $('btnRetryFailed').addEventListener('click', doRetryFailed);
  $('btnRefreshAll').addEventListener('click', doRefreshAll);

  $('filterRow').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const chips = $('filterRow').children;
    for (const c of chips) c.classList.remove('active');
    chip.classList.add('active');
    ui.filter = chip.dataset.f;
    renderResults(true);
  });
  $('resSearch').addEventListener('input', () => {
    ui.search = $('resSearch').value.trim();
    renderResults(true);
  });

  $('btnCopyCsv').addEventListener('click', doCopy);
  $('btnDlCsv').addEventListener('click', doDownload);
  $('btnOpenFull').addEventListener('click', () => chrome.tabs.create({ url: 'results.html' }));
  $('btnClearResults').addEventListener('click', doClearResults);

  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestKey').addEventListener('click', testKey);
  $('setProvider').addEventListener('change', () => {
    $('customFields').classList.toggle('hidden', $('setProvider').value !== 'custom');
  });
  $('setDelay').addEventListener('input', () => {
    $('delayVal').textContent = $('setDelay').value + ' ms';
  });
  $('setTheme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('setTheme').value;
  });
  $('btnTheme').addEventListener('click', toggleTheme);

  $('settingsModal').addEventListener('click', (ev) => {
    const saveBtn = ev.target.closest('[data-key-save]');
    if (saveBtn) { persistKey(saveBtn.dataset.keySave); return; }
    const clearBtn = ev.target.closest('[data-key-clear]');
    if (clearBtn) { clearKey(clearBtn.dataset.keyClear); return; }
    if (ev.target === $('settingsModal')) {
      $('settingsModal').classList.add('hidden');
    }
  });
  $('showKeys').addEventListener('change', applyKeyVisibility);
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  settings.theme = next;
  await sendMsgRetry({ type: 'setSettings', settings: settings });
}

async function init() {
  if (!extensionContextOk()) {
    const b = $('swBanner');
    b.textContent = '⚠ LeadScout must run as a browser extension. Open it from the Chrome/Edge toolbar, not as a file.';
    b.classList.remove('hidden');
    return;
  }
  await loadState();
  applyTheme();
  $('optMode').value = settings.scanMode || 'standard';
  $('optProvider').value = settings.provider || 'groq';
  $('optDeepScan').checked = settings.deepScan !== false;
  $('optEmails').checked = settings.includeEmails !== false;
  updateInputCount();
  renderProgress();
  renderResults(true);
  renderKeyWarnings();
  wire();
  if (job && (job.running || job.paused)) startPolling();
  checkSwHealth();
}

// v1.4.1: detect a dead background worker up front and tell the user exactly
// how to recover — no more silent failures (this is what "status code: 15"
// looked like from the UI: saves and starts just silently failed).
async function checkSwHealth() {
  const res = await sendMsgRetry({ type: 'ping' });
  const banner = $('swBanner');
  if (res && res.ok) {
    banner.classList.add('hidden');
    return;
  }
  banner.textContent = '⚠ Background worker failed to start. Fix: ' + extensionsUrl() + ' → LeadScout → Remove → "Load unpacked" this folder again (a full reinstall replaces any stale/mixed files). Detail: ' + String(res && res.error ? res.error : 'no response');
  banner.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', init);
