// LeadScout — troubleshooting logic.
//
// Turns what a page can see into plain findings: what is wrong, why, and which
// one-click fix applies. Pure on purpose — no DOM, no chrome.* — the page
// gathers the facts and performs the fixes, so every branch is unit-tested.

import { CRM_EXPORT_HEADERS, buildCSV, exportRowCount } from './parse.js';

/** Severity, lowest to highest. */
export const LEVELS = ['ok', 'info', 'warn', 'fail'];

export const LEVEL_LABELS = {
  ok: 'Working',
  info: 'Note',
  warn: 'Check this',
  fail: 'Problem'
};

function finding(id, level, title, detail, fix) {
  return { id, level, title, detail: detail || '', fix: fix || null };
}

/** One-line description of every fix a finding can ask for. */
export const FIX_LABELS = {
  'reload-page': 'Reload this window',
  'reload-extension': 'Reload the extension',
  'reset-filters': 'Show everything again',
  'resume': 'Resume research',
  'retry-failed': 'Retry failed companies',
  'refresh-all': 'Refresh all — latest data',
  'start-research': 'Go to the company box',
  'enable-resolve': 'Switch profile lookup on'
};

/**
 * Minimal RFC-4180 reader. The export is checked with its own reader so the
 * check never trusts the writer's quoting.
 */
export function readCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function filterLabel(ui) {
  const known = {
    'C-Suite': 'C-Suite', 'AI & Automation': 'AI & Automation', Product: 'Product',
    Engineering: 'Engineering', 'Digital & IT': 'Digital & IT', 'Innovation / R&D': 'Innovation / R&D',
    Security: 'Security', unverified: 'Unverified', review: 'Needs review'
  };
  const parts = [];
  if (ui.filter && ui.filter !== 'all') parts.push('"' + (known[ui.filter] || ui.filter) + '"');
  if (ui.search) parts.push('the search "' + ui.search + '"');
  return parts.join(' and ');
}

/** Share of export rows that have a value in column `index`. */
function fillShare(table, index) {
  const rows = table.slice(1);
  if (!rows.length) return 100;
  const filled = rows.filter(r => String(r[index] || '').trim() !== '').length;
  return Math.round((filled / rows.length) * 100);
}

/**
 * Why a column is sparse. Each note explains the real cause for that column
 * instead of a generic "no data".
 */
function columnNotes(table, facts, out) {
  const rows = table.slice(1);
  if (!rows.length) return;

  const linkedin = fillShare(table, 9);
  if (linkedin < 60) {
    let attempts = 0;
    let resolved = 0;
    let blocked = false;
    for (const c of (facts.allResults || [])) {
      const rs = c && c.discovery && c.discovery.resolve;
      if (!rs) continue;
      attempts += Number(rs.attempts) || 0;
      resolved += Number(rs.resolved) || 0;
      if (rs.state === 'blocked') blocked = true;
    }
    const head = 'LINKEDIN_URL is filled in ' + linkedin + '% of rows. ';
    const found = resolved + (resolved === 1 ? ' profile' : ' profiles');
    if (blocked) {
      out.push(finding('col-linkedin', 'warn', 'Profile lookup was stopped by a Bing check',
        head + 'Bing asked for a human check, so the lookup stopped after ' + attempts +
        (attempts === 1 ? ' attempt' : ' attempts') + ' (' + found + '). Finish the check in ' +
        'the Bing tab, then refresh.',
        facts.job && facts.job.paused ? 'resume' : 'refresh-all'));
    } else if (attempts > 0) {
      // The lookup is capped per company so a long list stays bounded; that
      // limit, as much as a missing profile, is why some cells stay empty.
      const cap = Number((facts.settings && facts.settings.maxResolvePerCompany)) || 6;
      out.push(finding('col-linkedin', 'info', 'Some people have no findable LinkedIn profile',
        head + 'LeadScout looked up ' + attempts + (attempts === 1 ? ' person' : ' people') +
        ' and found an indexed profile for ' + resolved + '. The lookup covers at most ' + cap +
        ' people per company in one run, and the rest either were beyond that limit or have no ' +
        'profile that search returns — the cell stays empty rather than guessed.'));
    } else {
      out.push(finding('col-linkedin', 'info', 'No profile lookup has run yet',
        head + 'Profiles come from search results or the company\'s own leadership page. Run ' +
        '"Refresh all" to look up the people who are still missing one.', 'refresh-all'));
    }
  }

  const email = fillShare(table, 3);
  if (email < 60) {
    const hunter = facts.settings && facts.settings.hunterKey;
    out.push(finding('col-email', 'info', 'Email is not known for every person',
      'EMAIL_ID is filled in ' + email + '% of rows. ' + (hunter
        ? 'Hunter.io is connected; it has no address for the others.'
        : 'No Hunter.io key is saved, so emails are pattern estimates built from the company website ' +
          '(add a free Hunter.io key in Settings for verified addresses).') +
      ' A company with no known website gets no email — the cell is left empty rather than guessed.'));
  }

  const factsShare = Math.min(fillShare(table, 5), fillShare(table, 6), fillShare(table, 7));
  if (factsShare < 60) {
    out.push(finding('col-facts', 'info', 'Company facts are missing for some companies',
      'COMPANY_SIZE, COUNTRY and INDUSTRY_TYPE are filled only where the company\'s LinkedIn page or ' +
      'its own website states them (least-filled column: ' + factsShare + '%). A company that blocks ' +
      'automated reading, or is not on LinkedIn, leaves them empty.'));
  }
}

/**
 * @param {object} facts plain data gathered by the page:
 *   version, contextOk, worker {ok, version, error}, guardError,
 *   missingBindings [], job, ui {filter, search}, comps (what an export would
 *   write now), allResults, settings {resolveProfiles, provider, hasKey,
 *   hunterKey}, clipboardOk, now
 *   Optional `csv` and `exportable`: a page whose rows are not grouped by
 *   company (the side-panel workspace) passes its own export text and row
 *   count, and the export check uses those instead of building from `comps`.
 * @returns {{level:string, findings:Array}} findings ordered most severe first
 */
export function diagnose(facts = {}) {
  const f = facts || {};
  const out = [];
  const job = f.job || null;
  const allResults = Array.isArray(f.allResults) ? f.allResults : (job && job.results) || [];
  const comps = Array.isArray(f.comps) ? f.comps : [];
  const ui = f.ui || {};
  // "Found" is everyone research returned; "exportable" is what the CSV writes.
  const foundInView = comps.reduce((n, c) => n + ((c.people || []).length), 0);
  const foundOverall = allResults.reduce((n, c) => n + ((c.people || []).length), 0);
  const pastInView = comps.reduce((n, c) =>
    n + (c.people || []).filter(p => p.currentEmployer === 'review-past').length, 0);
  const exportable = typeof f.exportable === 'number' ? f.exportable : exportRowCount(comps);
  const exportableOverall = typeof f.exportableOverall === 'number' ? f.exportableOverall
    : exportRowCount(allResults);

  // ---- the extension itself ------------------------------------------------
  if (f.contextOk === false) {
    out.push(finding('context', 'fail', 'This window outlived the extension',
      'LeadScout was reloaded or updated while this window was open, so the page can no longer ' +
      'talk to it. Reload this window to pick up the running build.', 'reload-page'));
  } else {
    const worker = f.worker || null;
    if (!worker || !worker.ok) {
      out.push(finding('worker', 'fail', 'The background worker is not answering',
        'Research and saving keys run in the background worker, so nothing works until it starts. ' +
        'Reported error: ' + String((worker && worker.error) || 'no response') + '. ' +
        'Click Reload extension; if it still fails, remove LeadScout on the extensions page and ' +
        'load the folder again.', 'reload-extension'));
    } else if (worker.version && f.version && worker.version !== f.version) {
      out.push(finding('worker', 'fail', 'Two builds are running at once',
        'This page is version ' + f.version + ' but the background worker reports ' + worker.version +
        '. The folder was changed while the extension was loaded. Reload the extension so every ' +
        'file comes from the same build.', 'reload-extension'));
    } else {
      out.push(finding('worker', 'ok', 'Background worker is running',
        'Version ' + (worker.version || f.version || '') + ' answered the health check.'));
    }
  }

  if (f.guardError) {
    out.push(finding('page-error', 'fail', 'A script error was caught on this page',
      String(f.guardError) + ' Reload the extension; if the message returns, the folder holds a broken file.',
      'reload-extension'));
  }

  const missing = Array.isArray(f.missingBindings) ? f.missingBindings : [];
  if (missing.length) {
    out.push(finding('wiring', 'fail', missing.length + ' button' + (missing.length === 1 ? ' has' : 's have') + ' no action',
      'This page and its script come from different builds, so ' +
      missing.slice(0, 6).map(id => '#' + id).join(', ') + (missing.length > 6 ? '…' : '') +
      ' do nothing when clicked. Reload the extension; if it stays, remove LeadScout and load the ' +
      'folder again.', 'reload-extension'));
  }

  // ---- the research results ------------------------------------------------
  if (!allResults.length) {
    out.push(finding('results', 'info', 'No research results yet',
      'Paste companies in the box and press Start research (or Ctrl+Enter). Rows appear here as ' +
      'each company finishes.', 'start-research'));
  } else {
    const queue = (job && job.queue) || [];
    const total = queue.length;
    const done = queue.filter(q => q.status === 'done').length;
    const failed = queue.filter(q => q.status === 'failed');

    if (job && job.running) {
      out.push(finding('state', 'info', 'Research is running',
        done + ' of ' + total + ' companies are finished. The CSV contains what is already done; ' +
        'download again when the run ends.'));
    }
    if (job && job.paused) {
      out.push(finding('state', 'warn', 'Research is paused',
        (job.attention ? job.attention + ' ' : '') + 'Nothing new is researched until you resume.',
        'resume'));
    }

    if (failed.length) {
      out.push(finding('failed', 'warn', failed.length + ' compan' + (failed.length === 1 ? 'y failed' : 'ies failed'),
        failed.slice(0, 5).map(q => q.name || q.input).join(', ') +
        (failed.length > 5 ? '…' : '') + '. Retry runs them again.', 'retry-failed'));
    }

    const label = filterLabel(ui);
    if (label) {
      out.push(finding('filter', 'warn', 'The export follows the active filter',
        'Only ' + label + ' is in view, so the CSV will contain ' + exportable + ' of ' +
        exportableOverall + ' people. Show everything again to export all of them.', 'reset-filters'));
    }

    // Set when the "nothing to export" finding already explains the past roles.
    let pastExplained = false;
    if (!exportable) {
      if (foundInView && pastInView === foundInView) {
        pastExplained = true;
        out.push(finding('export', 'fail', 'Everyone in view is flagged as a possibly-past role',
          'All ' + foundInView + ' people in view are marked as possibly no longer in that role, so ' +
          'none is written to the CSV. A past role is never exported as a current one.' +
          (label ? ' Clear the filter to see the rest.' : ''), label ? 'reset-filters' : null));
      } else {
        const review = comps.filter(c => !(c.people || []).length);
        const reasons = {};
        for (const c of review) {
          const key = c.reviewReason || c.outcome || 'No evidence-backed decision-maker was found';
          reasons[key] = (reasons[key] || 0) + 1;
        }
        const why = Object.keys(reasons).map(k => reasons[k] + ' × ' + k).join('; ');
        out.push(finding('export', 'warn', 'No prospects can be exported right now',
          foundOverall
            ? (foundOverall + ' people were found in total, but none can be exported from the ' +
               'current view. ' + (why ? 'Companies in view that need a look: ' + why + '. ' : '') +
               'Clear the filter, or run Deep mode for more sources.')
            : ('None of the ' + allResults.length + ' researched companies produced an accepted ' +
               'person. ' + (why ? 'Why: ' + why + '. ' : '') +
               'Try Deep mode, or paste the exact LinkedIn company URL.'),
          foundOverall ? (label ? 'reset-filters' : null) : 'refresh-all'));
      }
    } else {
      // ---- the export itself: built now and read back with its own reader ----
      const csv = typeof f.csv === 'string' ? f.csv : buildCSV(comps);
      const table = readCsv(csv);
      const headerOk = same(table[0], CRM_EXPORT_HEADERS);
      const widthsOk = table.slice(1).every(r => r.length === CRM_EXPORT_HEADERS.length);
      if (headerOk && widthsOk && table.length - 1 === exportable) {
        out.push(finding('export', 'ok', 'CSV export check passed',
          exportable + ' row' + (exportable === 1 ? '' : 's') + ' × exactly 10 columns, in the contract ' +
          'order. A downloaded file contains the same bytes as this check.'));
      } else {
        out.push(finding('export', 'fail', 'The CSV does not match the 10-column contract',
          'Header matches: ' + (headerOk ? 'yes' : 'no') + '. Every row has 10 fields: ' +
          (widthsOk ? 'yes' : 'no') + '. Rows: ' + (table.length - 1) + ' (expected ' + exportable + '). ' +
          'Reload the extension so every file comes from the same build.', 'reload-extension'));
      }
      if (headerOk && widthsOk) columnNotes(table, { ...f, allResults, job }, out);
    }

    // People the grid and the CSV both leave out deserve a visible reason.
    const pastTotal = allResults.reduce((n, c) =>
      n + (c.people || []).filter(p => p.currentEmployer === 'review-past').length, 0);
    if (pastTotal && !pastExplained) {
      out.push(finding('past-roles', 'info', pastTotal + (pastTotal === 1 ? ' person is' : ' people are') +
        ' left out as a possibly-past role',
        (pastTotal === 1 ? 'One person found' : pastTotal + ' people found') +
        ' during research seem' + (pastTotal === 1 ? 's' : '') + ' no longer to be in that role at that ' +
        'company (the source says "former", "was", or gives a dated role). They are not shown in the ' +
        'grid and not written to the CSV: a past role is never exported as a current one.'));
    }

    const finishedAt = Number(job && job.finishedAt) || 0;
    const now = Number(f.now) || Date.now();
    if (finishedAt && !(job && job.running) && now - finishedAt > 7 * 86400000) {
      const days = Math.round((now - finishedAt) / 86400000);
      out.push(finding('stale', 'info', 'These results are ' + days + ' days old',
        'Roles change. Refresh all researches every company again so the CSV reflects the latest ' +
        'public information.', 'refresh-all'));
    }
  }

  // ---- settings --------------------------------------------------------------
  const settings = f.settings || null;
  if (settings && settings.resolveProfiles === false) {
    out.push(finding('setting-resolve', 'warn', 'Profile lookup is switched off',
      '"Fill missing LinkedIn URLs" is off, so LINKEDIN_URL stays empty unless a company page ' +
      'linked the profile itself. Switch it on, then Refresh all.', 'enable-resolve'));
  }
  if (settings) {
    const provider = settings.provider || 'none';
    out.push(finding('setting-ai', 'info', 'AI enrichment: ' +
      (provider === 'none' ? 'off' : (provider + (settings.hasKey ? ' (key saved)' : ' (no key saved — not used)'))),
      provider === 'none'
        ? 'Results come from public search results and company pages only. Add a free Groq or Gemini ' +
          'key in Settings to fill more company facts.'
        : (settings.hasKey
          ? 'Used to structure results and fill company facts. It cannot add a person the sources do not name.'
          : 'No key is saved for ' + provider + ', so it is skipped. Save a key in Settings or pick ' +
            '"None (Bing only)" to hide this note.')));
  }

  if (f.clipboardOk === false) {
    out.push(finding('clipboard', 'warn', 'The clipboard is blocked in this window',
      'Browsers block "Copy CSV" when the popup loses focus. Use Download CSV instead — the file is ' +
      'identical to what Copy would place on the clipboard.'));
  }

  const order = { fail: 0, warn: 1, ok: 2, info: 3 };
  const findings = out.slice().sort((a, b) => order[a.level] - order[b.level]);
  const level = findings.some(x => x.level === 'fail') ? 'fail'
    : (findings.some(x => x.level === 'warn') ? 'warn' : 'ok');
  return { level, findings };
}

/** Headline for the top of the panel. */
export function headline(result) {
  const fails = result.findings.filter(x => x.level === 'fail').length;
  const warns = result.findings.filter(x => x.level === 'warn').length;
  if (fails) return (fails === 1 ? 'One problem stops LeadScout from working' : fails + ' problems need fixing') +
    (warns ? ' · ' + warns + ' more to check' : '');
  if (warns) return (warns === 1 ? 'Nothing is broken — one thing to check' : 'Nothing is broken — ' + warns + ' things to check');
  return 'Everything checks out';
}

/** Plain-text report, for pasting into an issue or a message. */
export function reportText(result, facts = {}) {
  const f = facts || {};
  const lines = ['LeadScout troubleshooting report'];
  lines.push('Version ' + (f.version || '?') + (f.browser ? ' · ' + f.browser : '') +
    (f.page ? ' · ' + f.page + ' page' : '') +
    (f.now ? ' · ' + new Date(f.now).toLocaleString() : ''));
  lines.push('Result: ' + headline(result));
  lines.push('Columns: ' + CRM_EXPORT_HEADERS.join(', '));
  lines.push('');
  for (const x of result.findings) {
    lines.push('[' + LEVEL_LABELS[x.level].toUpperCase() + '] ' + x.title);
    if (x.detail) lines.push('    ' + x.detail);
    if (x.fix) lines.push('    Fix: ' + (FIX_LABELS[x.fix] || x.fix));
  }
  return lines.join('\n');
}
