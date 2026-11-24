// LeadScout — workspace record model.
//
// The side-panel workspace is a flat table (one prospect per row), unlike the
// research pipeline which groups people under a company.  Both end up in the
// same ten-column CRM contract, so the mapping lives here: pure functions only,
// unit-tested in tools/test.mjs, no DOM and no chrome.* calls.

import {
  CRM_EXPORT_HEADERS, splitProspectName, linkedinUrlForExport,
  websiteNameForExport, exportCell, cell
} from './parse.js';

/** Field order used by the table, storage and both exporters. */
export const RECORD_FIELDS = [
  'firstName', 'lastName', 'designation', 'email', 'company',
  'companySize', 'country', 'industry', 'website', 'linkedinUrl'
];

/** Resolution states shown as badges in the LINKEDIN_URL column. */
export const RESOLVE_STATUS = {
  direct: 'Verified Direct',
  auto: 'Auto-Resolved',
  review: 'Needs Review'
};

export function emptyRecord(overrides = {}) {
  const base = {};
  for (const f of RECORD_FIELDS) base[f] = '';
  base.status = '';
  base.source = '';
  return { ...base, ...overrides };
}

/**
 * Coerce anything the extractor/UI hands us into the canonical shape.  Values
 * are trimmed, never invented: an unknown field stays empty.
 */
export function normalizeRecord(input = {}) {
  const rec = emptyRecord();
  rec.firstName = cell(input.firstName);
  rec.lastName = cell(input.lastName);
  rec.designation = cell(input.designation);
  rec.email = cell(input.email).toLowerCase();
  rec.company = cell(input.company);
  rec.companySize = cell(input.companySize);
  rec.country = cell(input.country);
  rec.industry = cell(input.industry);
  rec.website = websiteNameForExport(input.website);
  rec.linkedinUrl = linkedinUrlForExport(input.linkedinUrl);
  rec.status = Object.prototype.hasOwnProperty.call(RESOLVE_STATUS, input.status) ? input.status : '';
  rec.source = cell(input.source);
  // A full name with no split yet is split once, here, using the CRM rules.
  if ((!rec.firstName && !rec.lastName) && input.name) {
    const parts = splitProspectName(input.name);
    rec.firstName = parts.firstName;
    rec.lastName = parts.lastName;
  }
  return rec;
}

/** A prospect needs at least one person-level value; a company alone is not a lead. */
export function hasPerson(rec) {
  const v = normalizeRecord(rec);
  return !!(v.firstName || v.lastName || v.email || v.linkedinUrl);
}

export function isBlankRecord(rec) {
  return RECORD_FIELDS.every(f => !cell(rec[f]));
}

/**
 * Identity for de-duplication: a real profile URL wins, then email+name.
 * Rows with no identity are never merged (they are distinct manual rows).
 */
export function recordKey(rec) {
  const r = normalizeRecord(rec);
  if (r.linkedinUrl) return 'li:' + r.linkedinUrl.toLowerCase();
  if (r.email) return 'em:' + r.email + '|' + r.firstName.toLowerCase() + '|' + r.lastName.toLowerCase();
  return '';
}

/**
 * Merge incoming rows into the current table.  Existing values are kept; an
 * incoming value only fills a blank.  Returns the new list plus a count so the
 * UI can say "6 added, 2 updated".
 */
export function mergeRecords(existing, incoming) {
  const out = (existing || []).map(normalizeRecord);
  const index = new Map();
  out.forEach((r, i) => { const k = recordKey(r); if (k && !index.has(k)) index.set(k, i); });
  let added = 0;
  let updated = 0;
  for (const raw of (incoming || [])) {
    const rec = normalizeRecord(raw);
    if (isBlankRecord(rec) || !hasPerson(rec)) continue;
    const key = recordKey(rec);
    const at = key ? index.get(key) : undefined;
    if (at === undefined) {
      out.push(rec);
      if (key) index.set(key, out.length - 1);
      added++;
      continue;
    }
    const cur = out[at];
    let touched = false;
    for (const f of RECORD_FIELDS) {
      if (!cur[f] && rec[f]) { cur[f] = rec[f]; touched = true; }
    }
    if (!cur.status && rec.status) { cur.status = rec.status; touched = true; }
    if (!cur.source && rec.source) { cur.source = rec.source; touched = true; }
    if (touched) updated++;
  }
  return { rows: out, added, updated };
}

/** The ten values, in the exact CRM order, for one record. */
export function recordRow(rec) {
  const r = normalizeRecord(rec);
  return [
    r.firstName, r.lastName, r.designation, r.email, r.company,
    r.companySize, r.country, r.industry, r.website, r.linkedinUrl
  ];
}

/** RFC-4180 CSV body (no BOM — the download path adds it). */
export function recordsToCSV(records) {
  const lines = [CRM_EXPORT_HEADERS.join(',')];
  for (const rec of (records || [])) {
    if (isBlankRecord(rec)) continue;
    const cells = recordRow(rec).map(v => {
      const s = exportCell(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Tab-separated body for pasting straight into Sheets or Excel. */
export function recordsToTSV(records) {
  const lines = [CRM_EXPORT_HEADERS.join('\t')];
  for (const rec of (records || [])) {
    if (isBlankRecord(rec)) continue;
    lines.push(recordRow(rec).map(v => exportCell(v).replace(/[\t\r\n]+/g, ' ')).join('\t'));
  }
  return lines.join('\n');
}

/**
 * Tier-2 queries, most productive first.
 *
 * Measured on Bing: `site:linkedin.com/in/ "Name" "Company"` returns zero
 * results — a second quoted phrase (and the trailing slash) collapses the
 * result set. `site:linkedin.com/in "Name"` returns the profile. So the name
 * query goes first and the company is only a narrower retry.
 */
export function linkedinSearchQueries(rec) {
  const r = normalizeRecord(rec);
  const name = [r.firstName, r.lastName].filter(Boolean).join(' ');
  if (!name) return [];
  const out = ['site:linkedin.com/in "' + name + '"'];
  const anchor = r.company || r.designation;
  if (anchor) out.push('site:linkedin.com/in "' + name + '" ' + anchor);
  return out;
}

/** Kept for callers that only need the primary query. */
export function linkedinSearchQuery(rec) {
  const list = linkedinSearchQueries(rec);
  return list.length ? list[0] : '';
}

/** The company token a profile snippet must mention, when we have one. */
export function companyToken(company) {
  const stop = /^(?:the|ltd|limited|inc|incorporated|plc|llp|corp|corporation|gmbh|pte|pvt|private|group|holdings?|company|co|industries|industry|world|global|international)$/i;
  const words = String(company || '').split(/[^A-Za-z0-9&]+/).filter(Boolean);
  const hit = words.find(w => w.length > 2 && !stop.test(w));
  return (hit || '').toLowerCase();
}

/**
 * Choose a profile from search results.
 *
 * Every name token must appear in the result's own title or snippet, and when
 * we know the company its token must appear too — a same-name stranger is not
 * a match. Returns '' rather than guessing.
 */
export function pickProfileResult(results, rec) {
  const r = normalizeRecord(rec);
  const tokens = [r.firstName, r.lastName]
    .filter(Boolean).map(x => x.toLowerCase()).filter(x => x.length > 1);
  if (!tokens.length) return '';
  const company = companyToken(r.company);
  for (const item of (results || [])) {
    const url = linkedinUrlForExport(item && item.url);
    if (!url) continue;
    const hay = (String(item.title || '') + ' ' + String(item.snippet || '')).toLowerCase();
    if (!tokens.every(tok => hay.includes(tok))) continue;
    if (company && !hay.includes(company)) continue;
    return url;
  }
  return '';
}

/** Tier-3: a human-clickable search link, never a fabricated profile URL. */
export function verifySearchUrl(rec, host = 'www.google.com') {
  const q = linkedinSearchQuery(rec) || [rec.firstName, rec.lastName].filter(Boolean).join(' ');
  if (!q) return '';
  return 'https://' + host + '/search?q=' + encodeURIComponent(q);
}

export function needsResolution(rec) {
  return !normalizeRecord(rec).linkedinUrl;
}

/**
 * Parse a free-text selection into candidate rows.  Supports the shapes people
 * actually copy off a page or a spreadsheet:
 *
 *   Asha Shah — CTO at Acme Corp
 *   Asha Shah | Chief Technology Officer | Acme Corp
 *   Asha Shah, CTO, Acme Corp
 *   Name \n Title \n Company
 *
 * Anything that does not look like a person's name is dropped rather than
 * guessed at.
 */
export function parseSelectionText(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const out = [];
  const push = (name, role, company) => {
    const parts = splitProspectName(name);
    if (!parts.firstName) return;
    const rec = normalizeRecord({
      firstName: parts.firstName, lastName: parts.lastName,
      designation: role, company, source: 'selection'
    });
    if (!isBlankRecord(rec)) out.push(rec);
  };

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const bullet = /^[-*•·]\s+/;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(bullet, '').trim();
    if (!line) continue;
    // "Name — Title at Company" / "Name | Title | Company" / "Name, Title, Company"
    const split = line.split(/\s+[—–|]\s+|\s*\|\s*|,\s+/).map(s => s.trim()).filter(Boolean);
    if (split.length >= 2 && split.length <= 3) {
      const name = split[0];
      let role = split[1] || '';
      let company = split[2] || '';
      const at = role.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (at) { role = at[1]; company = company || at[2]; }
      push(name, role, company);
      continue;
    }
    // Plain "Name" line followed by "Title at Company".
    const one = line.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (one && splitProspectName(one[1]).firstName) {
      push(one[1], '', one[2]);
      continue;
    }
    const next = (lines[i + 1] || '').replace(bullet, '').trim();
    if (next && splitProspectName(line).firstName && !splitProspectName(next).firstName) {
      push(line, next, (lines[i + 2] || '').replace(bullet, '').trim());
      i += 2;
    }
  }
  return out;
}
