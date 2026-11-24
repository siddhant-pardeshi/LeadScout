// LeadScout — full-page results view

import { DEFAULT_SETTINGS, buildCSV, fmtEta } from './lib/parse.js';

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

// theme lives in settings; keep the page consistent with the popup
(async () => {
  const st = await chrome.storage.local.get(['settings']);
  const theme = (st.settings && st.settings.theme) || 'dark';
  document.documentElement.dataset.theme = theme;
})();

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

function pillEl(cls, txt) {
  const s = document.createElement('span');
  s.className = 'pill ' + cls;
  s.textContent = txt;
  return s;
}

function tdText(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
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

function verificationDisplay(person) {
  if (person.urlVerified) return { text: 'VERIFIED', cls: 'v' };
  if (person.sourceType === 'official') return { text: 'OFFICIAL', cls: 'v' };
  return { text: 'UNVERIFIED', cls: 'u' };
}

function roleDisplay(person) {
  if (person.currentEmployer === 'current') return { text: 'CURRENT', cls: 'v', title: 'Role at this company is title-verified (current)' };
  if (person.currentEmployer === 'official') return { text: 'OFFICIAL', cls: 'v', title: 'Current role stated by the company-owned source linked in this row' };
  if (person.currentEmployer === 'snippet') return { text: 'SNIPPET', cls: 'est', title: 'Company seen in the search snippet, with no past-role markers' };
  return { text: 'PAST?', cls: 'u', title: 'Contradictory signals — may be a past role, verify manually' };
}

// v1.4 lag fix: rebuild the table only when data actually changed
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
  $('resSummary').textContent =
    peopleCount + ' people · ' + verifiedCount + ' verified · ' +
    compCount + ' companies' + status;

  const visible = rows.filter(r => rowMatches(r, ui.filter, ui.search));
  const capped = visible.slice(0, 2000);
  const frag = document.createDocumentFragment();

  for (const r of capped) {
    const tr = document.createElement('tr');

    if (r.kind === 'review') {
      const review = reviewDisplay(r.comp);
      tr.appendChild(tdText('—', 'ds'));
      const reason = tdText(review.text, 'ds');
      reason.title = review.title;
      tr.appendChild(reason);
      tr.appendChild(tdText(r.comp.country || '', 'ds'));
      tr.appendChild(companyCell(r.comp));
      tr.appendChild(tdText(r.comp.size || '', 'ds'));
      tr.appendChild(tdText(r.comp.industry || '', 'ds'));
      const tdL = document.createElement('td');
      if (r.comp.url) tdL.appendChild(linkEl(r.comp.url, 'page'));
      else tdL.appendChild(document.createTextNode('—'));
      tr.appendChild(tdL);
      tr.appendChild(tdText('', ''));
      const tdF = document.createElement('td');
      tdF.appendChild(pillEl(review.cls, review.pill));
      tr.appendChild(tdF);
      frag.appendChild(tr);
      continue;
    }

    const p = r.p;
    const c = r.comp;
    tr.appendChild(tdText(p.name, 'nm'));

    const tdD = document.createElement('td');
    tdD.className = 'ds';
    const desigDiv = document.createElement('div');
    desigDiv.textContent = p.designation || '';
    tdD.appendChild(desigDiv);
    tr.appendChild(tdD);

    tr.appendChild(tdText(c.country || '', 'ds'));
    const tdCo = companyCell(c);
    if (c.aiNote) tdCo.title = c.aiNote;
    tr.appendChild(tdCo);
    tr.appendChild(tdText(c.size || '', 'ds'));
    tr.appendChild(tdText(c.industry || '', 'ds'));

    const tdL = document.createElement('td');
    if (p.url) tdL.appendChild(linkEl(p.url, 'profile'));
    else if (p.evidenceUrl) tdL.appendChild(linkEl(p.evidenceUrl, 'evidence'));
    else tdL.appendChild(document.createTextNode('—'));
    tr.appendChild(tdL);

    const tdE = document.createElement('td');
    tdE.className = 'est-mail';
    if (p.email) {
      tdE.textContent = p.email;
      tdE.title = p.emailStatus || 'Email status unavailable';
    } else {
      tdE.textContent = '—';
    }
    tr.appendChild(tdE);

    const tdF = document.createElement('td');
    tdF.appendChild(pillEl('p' + (p.pri || 5), p.priority || 'P5'));
    tdF.appendChild(document.createTextNode(' '));
    const verify = verificationDisplay(p);
    tdF.appendChild(pillEl(verify.cls, verify.text));
    if (p.currentEmployer) {
      tdF.appendChild(document.createTextNode(' '));
      const role = roleDisplay(p);
      const rolePill = pillEl(role.cls, role.text);
      rolePill.title = role.title;
      tdF.appendChild(rolePill);
    }
    tr.appendChild(tdF);

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
    // v1.4: keep live while running OR paused — a resume elsewhere must not
    // leave this page dead
    if (!job || (!job.running && !job.paused)) stopPolling();
  }, 1500);
}

function stopPolling() {
  if (ui.pollTimer) { clearInterval(ui.pollTimer); ui.pollTimer = null; }
}

function exportTargets() {
  return ((job && job.results) || []).filter(c => c.status === 'done');
}

function hasAcceptedProspects(comps) {
  return comps.some(c => (c.people || []).length > 0);
}

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
      people: r.kind === 'person' ? [r.p] : [], hasReview: r.kind !== 'person'
    });
  }
  return [...map.values()].filter(c => c.people.length || c.hasReview);
}

async function doCopy() {
  const comps = filteredExportComps();
  if (!comps.length) { toast('No results yet'); return; }
  if (!hasAcceptedProspects(comps)) { toast('No accepted prospects in the current view'); return; }
  try {
    await navigator.clipboard.writeText(buildCSV(comps));
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
  download('leadscout-' + stamp() + '.csv',
    '\uFEFF' + buildCSV(comps),
    'text/csv;charset=utf-8');
  flashButton('btnDlCsv');
  toast('CSV saved — opens straight in Excel');
}

function flashButton(id) {
  const b = $(id);
  if (!b) return;
  b.classList.remove('flash');
  void b.offsetWidth; // restart the animation
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 650);
}

function wire() {
  $('filterRow').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const chips = $('filterRow').children;
    for (const c of chips) c.classList.remove('active');
    chip.classList.add('active');
    ui.filter = chip.dataset.f;
    render(true);
  });
  $('resSearch').addEventListener('input', () => {
    ui.search = $('resSearch').value.trim();
    render(true);
  });
  $('btnCopyCsv').addEventListener('click', doCopy);
  $('btnDlCsv').addEventListener('click', doDownload);
}

async function init() {
  const st = await chrome.storage.local.get(['job']);
  job = st.job || null;
  render();
  wire();
  if (job && (job.running || job.paused)) startPolling();
}

document.addEventListener('DOMContentLoaded', init);
