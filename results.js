// LeadScout — full-page results view.
//
// The grid shows exactly the ten columns the CSV writes, in the same order,
// with each cell reading the way the file does. It shares its row order and
// its cell values with the exporter, so the page cannot drift from the file.

import { DEFAULT_SETTINGS, buildCSV, exportRowCount, splitProspectName, exportablePeople,
  linkedinUrlForExport, websiteNameForExport } from './lib/parse.js';
import { extensionContextOk, extensionsUrl } from './lib/platform.js';
import { openTroubleshoot, closeTroubleshoot } from './lib/troubleshoot.js';

import { installGuard, on, onInput, missingBindings } from './lib/ui-guard.js';
installGuard('results');
const $ = (id) => document.getElementById(id);

let job = null;
const ui = { filter: 'all', search: '', pollTimer: null };

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
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

// The worker may still be registering right after the extension reloads.
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

function flashButton(id) {
  const b = $(id);
  if (!b) return;
  b.classList.remove('flash');
  void b.offsetWidth; // restart the animation
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 650);
}

// theme lives in settings; keep the page consistent with the popup
(async () => {
  const st = await chrome.storage.local.get(['settings']);
  const theme = (st.settings && st.settings.theme) || 'dark';
  document.documentElement.dataset.theme = theme;
})();

// The grid lists exactly the people the CSV writes, in the same order.
function flattenRows() {
  const rows = [];
  if (!job || !job.results) return rows;
  for (const comp of job.results) {
    const people = exportablePeople(comp);
    if (!people.length) {
      rows.push({ comp: comp, p: null, kind: 'review', pastOnly: (comp.people || []).length > 0 });
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

function tdText(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/** An empty cell, exactly as the CSV writes it. The tooltip says why. */
function blankCell(reason) {
  const td = tdText('', 'blank');
  if (reason) td.title = reason;
  return td;
}

/**
 * COMPANY_NAME holds the company's name and nothing else. The shortcut to its
 * LinkedIn page stays clickable but carries no text, so the cell reads exactly
 * like the value written to the CSV.
 */
function companyCell(comp) {
  const td = tdText(comp.name || comp.input || '', 'co');
  if (comp.url && /^https?:\/\//i.test(comp.url)) {
    const link = document.createElement('a');
    link.className = 'co-link';
    link.href = comp.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.title = 'Company LinkedIn page';
    link.setAttribute('aria-label', 'Company LinkedIn page');
    td.appendChild(link);
  }
  return td;
}

// Only a real web address becomes a link — never javascript: or data:.
function linkEl(href, txt) {
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

/** @param pastOnly the company had people, but all are flagged as possibly-past roles. */
function reviewDisplay(comp, pastOnly) {
  if (pastOnly) {
    return {
      pill: 'REVIEW',
      text: 'Everyone found here is flagged as a possibly-past role, so none is exported',
      title: 'A past role is never written to the CSV as a current one.',
      cls: 'u'
    };
  }
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

// Profile-backfill surfacing: the resolver runs per company; without this the
// "no LinkedIn URL" outcome is a silent mystery when Bing stalls it.
function resolveTotals(results) {
  let attempts = 0, resolved = 0, blocked = false;
  for (const c of (results || [])) {
    const rs = c && c.discovery && c.discovery.resolve;
    if (!rs) continue;
    attempts += Number(rs.attempts) || 0;
    resolved += Number(rs.resolved) || 0;
    if (rs.state === 'blocked') blocked = true;
  }
  return { attempts: attempts, resolved: resolved, blocked: blocked };
}

function resolveSummary(results) {
  const t = resolveTotals(results);
  if (!t.attempts && !t.resolved) return '';
  let txt = ' · profile lookup: ' + t.resolved + '/' + t.attempts + ' found';
  if (t.blocked) txt += ' — paused by a Bing check: solve it, then ⟳ Refresh all';
  return txt;
}

function resolveTitle(comp) {
  const rs = comp && comp.discovery && comp.discovery.resolve;
  if (!rs || (!rs.attempts && rs.state !== 'blocked')) return '';
  return 'profile lookup: ' + (rs.resolved || 0) + '/' + (rs.attempts || 0) +
    (rs.state === 'blocked' ? ' — blocked by a Bing check; Refresh all after solving it' : '');
}

/** Why a person has no profile address, when the lookup recorded a reason. */
function blankProfileReason(person) {
  const state = person.resolveState;
  if (state === 'consent' || state === 'captcha') return 'Bing asked for a human check — complete it, then Refresh all';
  if (state === 'no_match') return 'Searched, but no LinkedIn profile naming this person was found';
  if (state === 'no_name') return 'Name is too incomplete to search for';
  return 'No LinkedIn profile found for this person — left empty, never guessed';
}

// Rebuild the table only when the data actually changed (the poll runs often).
let lastKey = '';

function render(force) {
  if (!job) return;
  let doneN = 0, peopleN = 0;
  for (const c of (job.results || [])) {
    if (c.status === 'done') doneN++;
    peopleN += (c.people || []).length;
  }
  const key = doneN + '|' + peopleN + '|' + (job.running ? 'r' : '') + (job.paused ? 'p' : '') + (job.finishedAt || 0) + '|' + (job.updatedAt || 0);
  if (!force && key === lastKey) return;
  lastKey = key;

  const rows = flattenRows();
  const peopleCount = rows.filter(r => r.kind === 'person').length;
  const verifiedCount = rows.filter(r => r.kind === 'person' && r.p.urlVerified).length;
  const compCount = (job.results || []).length;
  let status = '';
  if (job.running) status = ' · running…';
  else if (job.paused) status = ' · paused';
  status += resolveSummary(job.results || []);
  $('resSummary').textContent =
    peopleCount + ' people · ' + verifiedCount + ' verified · ' +
    compCount + ' companies' + status;

  const visible = rows.filter(r => rowMatches(r, ui.filter, ui.search));
  const capped = visible.slice(0, 2000);
  const frag = document.createDocumentFragment();

  for (const r of capped) {
    const tr = document.createElement('tr');

    if (r.kind === 'review') {
      // A company with no accepted person explains itself in the DESIGNATION
      // cell; every other cell stays empty so the row still has 10 columns.
      const review = reviewDisplay(r.comp, r.pastOnly);
      tr.appendChild(blankCell('No prospect for this company'));
      tr.appendChild(blankCell('No prospect for this company'));
      const reason = tdText(review.text, 'ds');
      reason.title = review.title;
      tr.appendChild(reason);
      tr.appendChild(blankCell('No prospect for this company'));
      tr.appendChild(companyCell(r.comp));
      tr.appendChild(tdText(r.comp.size || '', 'ds'));
      tr.appendChild(tdText(r.comp.country || '', 'ds'));
      tr.appendChild(tdText(r.comp.industry || '', 'ds'));
      tr.appendChild(tdText(websiteNameForExport(r.comp.website), 'ds'));
      tr.appendChild(blankCell('No prospect for this company'));
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

    // What is on screen is what the CSV holds: a value, or an empty cell.
    if (p.email) {
      const tdE = tdText(p.email, 'est-mail');
      tdE.title = p.emailStatus || 'Email status unavailable';
      tr.appendChild(tdE);
    } else {
      tr.appendChild(blankCell('No email found for this person — left empty, never guessed'));
    }

    const tdCo = companyCell(c);
    if (c.aiNote) tdCo.title = c.aiNote;
    const rTitle = resolveTitle(c);
    if (rTitle) tdCo.title = (tdCo.title ? tdCo.title + ' · ' : '') + rTitle;
    tr.appendChild(tdCo);

    tr.appendChild(tdText(c.size || '', 'ds'));
    tr.appendChild(tdText(c.country || '', 'ds'));
    tr.appendChild(tdText(c.industry || '', 'ds'));
    tr.appendChild(tdText(websiteNameForExport(c.website), 'ds'));

    // The cell shows the profile address itself, as the CSV writes it.
    const profileUrl = linkedinUrlForExport(p.url);
    const tdL = document.createElement('td');
    tdL.className = 'url';
    if (profileUrl) {
      const a = linkEl(profileUrl, profileUrl);
      if (p.linkedinSource === 'official-page') a.title = 'Link published on the company page';
      else if (p.linkedinSource === 'search') a.title = 'Found by a profile search';
      else a.title = 'LinkedIn profile';
      tdL.appendChild(a);
    } else {
      tdL.title = blankProfileReason(p);
    }
    tr.appendChild(tdL);

    frag.appendChild(tr);
  }

  $('resBody').replaceChildren(frag);
  $('truncateNote').textContent = visible.length > capped.length
    ? ('Showing ' + capped.length + ' of ' + visible.length + ' rows — refine filters or export for the full set.')
    : '';
}

function startPolling() {
  if (ui.pollTimer) return;
  ui.pollTimer = setInterval(async () => {
    const st = await chrome.storage.local.get(['job']);
    job = st.job || job;
    render(false);
    // Keep live while running OR paused — a resume elsewhere must not leave
    // this page dead.
    if (!job || (!job.running && !job.paused)) stopPolling();
  }, 1500);
}

function stopPolling() {
  if (ui.pollTimer) { clearInterval(ui.pollTimer); ui.pollTimer = null; }
}

// -------------------------------------------------------------- exports ----

function exportTargets() {
  return ((job && job.results) || []).filter(c => c.status === 'done');
}

/**
 * When a filter chip or the search box is active, an export writes only the
 * rows in view (grouped back by company). Otherwise it writes everything.
 */
function filteredExportComps() {
  const comps = exportTargets();
  const filtering = (ui.filter !== 'all') || !!ui.search;
  if (!filtering) return comps;
  const rows = flattenRows().filter(r => r.comp.status === 'done' && rowMatches(r, ui.filter, ui.search));
  const map = new Map();
  for (const r of rows) {
    const existing = map.get(r.comp.id);
    if (existing) {
      if (r.kind === 'person') existing.people.push(r.p);
      else existing.hasReview = true;
      continue;
    }
    map.set(r.comp.id, {
      id: r.comp.id, input: r.comp.input, url: r.comp.url, name: r.comp.name,
      industry: r.comp.industry, size: r.comp.size, hq: r.comp.hq, country: r.comp.country,
      website: r.comp.website,
      outcome: r.comp.outcome, reviewReason: r.comp.reviewReason, reviewDetail: r.comp.reviewDetail,
      discovery: r.comp.discovery,
      people: r.kind === 'person' ? [r.p] : [], hasReview: r.kind !== 'person'
    });
  }
  return [...map.values()].filter(c => c.people.length || c.hasReview);
}

/**
 * What an export would write right now, or null when it would write nothing.
 * In that case the reason is shown instead of a silent failure.
 */
function selectionForExport() {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet — research some companies first'); return null; }
  if (!exportRowCount(comps)) {
    toast('Nothing to export yet — Troubleshoot explains why');
    openTroubleshootPanel();
    return null;
  }
  return comps;
}

async function doCopy() {
  const comps = selectionForExport();
  if (!comps) return;
  try {
    await navigator.clipboard.writeText(buildCSV(comps));
    flashButton('btnCopyCsv');
    toast('Copied the 10-column CSV');
  } catch (e) {
    toast('Clipboard blocked — use Download CSV instead');
  }
}

function doDownload() {
  const comps = selectionForExport();
  if (!comps) return;
  // BOM first so Excel reads the UTF-8 names correctly
  download('leadscout-' + stamp() + '.csv',
    '\uFEFF' + buildCSV(comps),
    'text/csv;charset=utf-8');
  flashButton('btnDlCsv');
  toast('CSV saved — exactly 10 columns, opens straight in Excel');
}

// ---------------------------------------------------------- troubleshoot ----

/** Everything the diagnosis needs, read from this page and the extension. */
async function gatherFacts() {
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (e) { /* context gone */ }
  const ping = await sendMsg({ type: 'ping' }).catch(() => ({ ok: false, error: 'no response' }));
  const st = await chrome.storage.local.get(['settings', 'job']);
  const saved = (st && st.settings) || {};
  const provider = saved.provider || DEFAULT_SETTINGS.provider;
  const keys = saved.keys || {};
  const hasKey = provider === 'none' ? false
    : (provider === 'custom' ? !!(saved.customBase && keys.custom) : !!keys[provider]);
  let clipboardOk = false;
  try { clipboardOk = !!(navigator.clipboard && navigator.clipboard.writeText); } catch (e) { clipboardOk = false; }
  return {
    version: version,
    page: 'results',
    contextOk: extensionContextOk(),
    worker: ping && ping.ok ? { ok: true, version: ping.version }
      : { ok: false, error: String((ping && ping.error) || 'no response') },
    guardError: (document.getElementById('ls-guard-banner') || {}).textContent || '',
    missingBindings: missingBindings(),
    job: job,
    ui: { filter: ui.filter, search: ui.search },
    comps: filteredExportComps(),
    allResults: (job && job.results) || [],
    settings: {
      resolveProfiles: saved.resolveProfiles !== false,
      maxResolvePerCompany: saved.maxResolvePerCompany,
      provider: provider,
      hasKey: hasKey,
      hunterKey: !!keys.hunter
    },
    clipboardOk: clipboardOk,
    now: Date.now()
  };
}

function resetFilters() {
  ui.filter = 'all';
  ui.search = '';
  const search = $('resSearch');
  if (search) search.value = '';
  const row = $('filterRow');
  if (row) {
    for (const chip of row.querySelectorAll('.chip')) {
      chip.classList.toggle('active', chip.dataset.f === 'all');
    }
  }
  render(true);
}

/**
 * Reload the extension in one click. If the page has already lost its
 * extension context, open the extensions page for the manual reload instead.
 */
function reloadExtension() {
  try {
    if (extensionContextOk()) { chrome.runtime.reload(); return; }
  } catch (e) { /* fall through to the manual route */ }
  try { chrome.tabs.create({ url: extensionsUrl() }); } catch (e) { /* nothing else to try */ }
  toast('On the extensions page, click ↻ on LeadScout', 4000);
}

/** Queue the given companies again by sending the worker their original input. */
function requeue(list) {
  return sendMsgRetry({ type: 'start', items: list.map(q => ({
    type: q.type, slug: q.slug, name: q.name, input: q.input, status: 'queued', error: ''
  })) }).then(() => { startPolling(); return true; });
}

async function resumeResearch() {
  await sendMsgRetry({ type: 'resume' });
  startPolling();
}

async function enableResolve() {
  const st = await chrome.storage.local.get(['settings']);
  const saved = { ...(st.settings || {}), resolveProfiles: true };
  await sendMsgRetry({ type: 'setSettings', settings: saved });
  toast('Profile lookup is on — Refresh all looks up the missing profiles');
}

function openPopup() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
}

function openTroubleshootPanel() {
  const queue = (job && job.queue) || [];
  openTroubleshoot({
    gather: gatherFacts,
    fixes: {
      'reload-page': () => location.reload(),
      'reload-extension': reloadExtension,
      'reset-filters': resetFilters,
      'resume': resumeResearch,
      'retry-failed': () => requeue(queue.filter(q => q.status === 'failed')),
      'refresh-all': () => requeue(queue.filter(q => q.status === 'done')),
      'start-research': () => { closeTroubleshoot(); openPopup(); },
      'enable-resolve': enableResolve
    }
  });
}

// ----------------------------------------------------------------- wire ----

function wire() {
  on('filterRow', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const chips = $('filterRow').children;
    for (const c of chips) c.classList.remove('active');
    chip.classList.add('active');
    ui.filter = chip.dataset.f;
    render(true);
  });
  onInput('resSearch', () => {
    ui.search = $('resSearch').value.trim();
    render(true);
  });
  on('btnTroubleshoot', openTroubleshootPanel);
  on('btnCopyCsv', doCopy);
  on('btnDlCsv', doDownload);
}

async function init() {
  const st = await chrome.storage.local.get(['job']);
  job = st.job || null;
  render();
  wire();
  if (job && (job.running || job.paused)) startPolling();
}

document.addEventListener('DOMContentLoaded', init);
