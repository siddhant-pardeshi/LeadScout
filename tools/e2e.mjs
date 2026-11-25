// LeadScout — real-browser end-to-end check.
//
// Drives the unpacked extension inside a real Chrome (started by tools/e2e.ps1):
// seeds a known research job, opens every extension page, presses the real
// export buttons, and verifies the bytes that come out. Nothing is mocked —
// the real manifest, service worker and pages run in the real browser.
//
//   powershell -ExecutionPolicy Bypass -File tools\e2e.ps1

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------ expectations ----

const CONTRACT = [
  'PROSPECT_FIRST_NAME', 'PROSPECT_LAST_NAME', 'DESIGNATION', 'EMAIL_ID', 'COMPANY_NAME',
  'COMPANY_SIZE', 'COUNTRY', 'INDUSTRY_TYPE', 'WEBSITE_NAME', 'LINKEDIN_URL'
];

const acme = {
  id: 'c1', input: 'https://www.linkedin.com/company/acme/', type: 'url', slug: 'acme',
  url: 'https://www.linkedin.com/company/acme/', name: 'Acme Corp',
  industry: 'Software Development', size: '201-500 employees', hq: 'Pune, Maharashtra, India',
  website: 'https://www.acme.example/about', country: 'India', factSource: 'linkedin',
  status: 'done', outcome: '', error: '',
  people: [
    { name: 'Jane Doe', designation: 'Chief Technology Officer', url: 'https://www.linkedin.com/in/jane-doe/?trk=public',
      urlVerified: true, currentEmployer: 'current', sourceType: 'linkedin', cat: 'C-Suite',
      pri: 1, score: 110, priority: 'P1', email: 'jane.doe@acme.io', emailStatus: 'pattern from Hunter.io (domain-verified)' },
    { name: 'José García', designation: 'VP of Engineering, Acme', url: '',
      urlVerified: false, currentEmployer: 'official', sourceType: 'official', cat: 'Engineering',
      evidenceUrl: 'https://www.acme.example/leadership', pri: 2, score: 90, priority: 'P2' },
    // A past role is listed in the UI but must never reach the CSV.
    { name: 'Old Hand', designation: 'Former CEO', url: 'https://www.linkedin.com/in/old-hand/',
      urlVerified: true, currentEmployer: 'review-past', cat: 'C-Suite', pri: 1, score: 80, priority: 'P1' },
    // A company page is not a person, so its LINKEDIN_URL must stay blank.
    { name: 'Bad Link', designation: 'Head of Product', url: 'https://www.linkedin.com/company/acme/',
      urlVerified: false, currentEmployer: 'current', cat: 'Product', pri: 2, score: 60, priority: 'P2' }
  ],
  discovery: { resolve: { attempts: 2, resolved: 1, state: 'ok' } }
};

const lupin = {
  id: 'c2', input: 'Lupin limited', type: 'name', slug: 'lupin-limited',
  url: 'https://www.linkedin.com/company/lupin-limited/', name: 'Lupin limited',
  industry: 'Pharmaceuticals', size: '26,000+ employees', hq: 'Mumbai, Maharashtra, India',
  website: 'https://www.lupin.com', country: '', factSource: 'linkedin',
  status: 'done', outcome: '', error: '',
  people: [
    { name: 'Nilesh D Gupta', designation: 'Managing Director', url: '',
      urlVerified: false, currentEmployer: 'official', sourceType: 'official', cat: 'C-Suite',
      evidenceUrl: 'https://www.lupin.com/leadership', pri: 1, score: 100, priority: 'P1' }
  ],
  discovery: { resolve: { attempts: 1, resolved: 0, state: 'no_match' } }
};

// A company with no accepted person explains itself in the UI and writes no row.
const empty = {
  id: 'c3', input: 'Empty Co', type: 'name', slug: '', url: '', name: 'Empty Co',
  industry: '', size: '', hq: '', website: '', country: '', factSource: 'none',
  status: 'done', outcome: 'no_profile_results',
  reviewReason: 'No matching LinkedIn profiles were returned by Bing', people: []
};

const SEED_JOB = {
  running: false, paused: false, cursor: 3, doneCount: 3, perCompanyMs: 1400,
  startedAt: 1, finishedAt: 2, updatedAt: 3, attention: null,
  queue: [
    { id: 'c1', type: 'url', slug: 'acme', name: null, input: acme.input, status: 'done', error: '' },
    { id: 'c2', type: 'name', slug: 'lupin-limited', name: 'Lupin limited', input: lupin.input, status: 'done', error: '' },
    { id: 'c3', type: 'name', slug: '', name: 'Empty Co', input: empty.input, status: 'done', error: '' }
  ],
  results: [acme, lupin, empty]
};

const SEED_ROWS = [
  { firstName: 'Asha', lastName: 'Shah', designation: 'Chief Technology Officer', email: 'asha.shah@acme.example',
    company: 'Acme Corp', companySize: '201-500 employees', country: 'India', industry: 'Software Development',
    website: 'acme.example', linkedinUrl: 'https://www.linkedin.com/in/asha-shah/?trk=x', status: 'direct', source: 'test' },
  { firstName: 'Ravi', lastName: 'Kumar Rao', designation: 'Head of AI', email: '',
    company: 'Lupin limited', companySize: '', country: '', industry: '', website: 'lupin.com', linkedinUrl: '', status: '', source: 'test' }
];

// The rows the download must contain, in order.
// Rows come out by company name, then by priority and score: P1 before P2.
const EXPECTED_ROWS = [
  ['Jane', 'Doe', 'Chief Technology Officer', 'jane.doe@acme.io', 'Acme Corp', '201-500 employees',
    'India', 'Software Development', 'acme.example', 'https://www.linkedin.com/in/jane-doe/'],
  ['José', 'García', 'VP of Engineering, Acme', '', 'Acme Corp', '201-500 employees',
    'India', 'Software Development', 'acme.example', ''],
  ['Bad', 'Link', 'Head of Product', '', 'Acme Corp', '201-500 employees',
    'India', 'Software Development', 'acme.example', ''],
  ['Nilesh', 'D Gupta', 'Managing Director', '', 'Lupin limited', '26,000+ employees',
    '', 'Pharmaceuticals', 'lupin.com', '']
];

const EXPECTED_WORKSPACE_ROWS = [
  ['Asha', 'Shah', 'Chief Technology Officer', 'asha.shah@acme.example', 'Acme Corp', '201-500 employees',
    'India', 'Software Development', 'acme.example', 'https://www.linkedin.com/in/asha-shah/'],
  ['Ravi', 'Kumar Rao', 'Head of AI', '', 'Lupin limited', '', '', '', 'lupin.com', '']
];

// ------------------------------------------------------------------ utils ----

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? '' : (process.argv[i + 1] || '');
}
const browserLog = arg('log');
if (!browserLog) {
  console.error('usage: node tools/e2e.mjs --log <browser stderr log>   (normally started by tools/e2e.ps1)');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label);
    await sleep(200);
  }
}

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params, msg.sessionId);
      }
    });
  }
  static connect(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('cannot reach the browser DevTools socket')), { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  once(method, sessionId) {
    return new Promise((resolve) => {
      const handler = (params, sid) => {
        if (sid !== sessionId) return;
        const list = this.handlers.get(method);
        list.splice(list.indexOf(handler), 1);
        resolve(params);
      };
      this.on(method, handler);
    });
  }
  close() { this.ws.close(); }
}

/** RFC-4180 reader, so the check does not trust the exporter's own quoting. */
function parseCsv(text) {
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

// ----------------------------------------------------------------- runner ----

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok  ' + name); }
  else {
    failed++;
    console.log('FAIL  ' + name);
    if (detail !== undefined) console.log('       ' + String(detail).split('\n').join('\n       ').slice(0, 700));
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The browser prints its DevTools socket address on stderr when it starts.
const socketAddress = await waitFor(() => {
  if (!existsSync(browserLog)) return '';
  const m = readFileSync(browserLog, 'utf8').match(/DevTools listening on (ws:\/\/\S+)/);
  return m ? m[1] : '';
}, 25000, 'the browser DevTools socket').catch((e) => { console.error(e.message); process.exit(3); });
const browser = await Cdp.connect(socketAddress);
console.log('browser connected on port ' + socketAddress.split(':')[2].split('/')[0]);

// Leave the browser alone while it starts. Connecting in the first fraction of
// a second after the DevTools port opens coincided with the unpacked extension
// failing to load in roughly half of the launches ("We couldn't install that
// app or extension", with no reason given). A launched browser that was not
// touched for its first second loaded every time.
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS) || 3000;
await sleep(SETTLE_MS);

/**
 * Find this extension's id by asking each extension worker for its manifest
 * name. The id cannot be derived from the folder path portably, and the
 * browser ships its own component extensions, so the name is the only proof
 * that *this* build was loaded.
 */
const seen = [];
const answered = new Map();   // targetId -> manifest name, so each worker is asked once
let targetScans = 0;
let unanswerable = 0;
let lastProbeError = '';
async function findExtension() {
  targetScans++;
  const { targetInfos } = await browser.send('Target.getTargets');
  if (targetScans === 1 && process.env.E2E_DEBUG) {
    console.log('debug: ' + targetInfos.map(t => t.type + ' ' + t.url.slice(0, 60)).join(' || '));
  }
  for (const t of targetInfos) {
    if (!t.url.startsWith('chrome-extension://')) continue;
    let name = answered.get(t.targetId);
    if (name === undefined) {
      try {
        // send() resolves to the protocol result, so the value is one level in.
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = await browser.send('Runtime.evaluate', {
          expression: 'chrome.runtime.getManifest().name', returnByValue: true
        }, sessionId);
        name = r && r.result && typeof r.result.value === 'string' ? r.result.value : '';
        answered.set(t.targetId, name);
      } catch (e) {
        // A worker that is still starting (or already idle) cannot be asked yet.
        unanswerable++;
        lastProbeError = t.url.split('/')[2] + ': ' + (e && e.message);
        continue;
      }
    }
    if (name && !seen.includes(name)) seen.push(name);
    if (/^LeadScout/.test(name)) return { id: t.url.split('/')[2], name };
  }
  return null;
}

// How long to wait for the extension. When it loads it does so in under a
// second; the generous wait only matters for diagnosing a launch that fails.
const LOAD_WAIT_MS = Number(process.env.E2E_LOAD_WAIT_MS) || 45000;
const loadStartedAt = Date.now();

/** The browser's own account of the extension, for when it did not appear. */
function browserLogLines() {
  try {
    return readFileSync(browserLog, 'utf8').split(/\r?\n/)
      .filter(line => /extension|LeadScout|load-extension/i.test(line) && !/fallback_task_provider|ProtocolLaunch/i.test(line))
      .map(line => line.replace(/^\[\d+:\d+:[\d/.]+:/, '').slice(0, 420))
      .filter((line, i, all) => all.indexOf(line) === i)
      .slice(0, 22);
  } catch (e) {
    return ['(browser log not readable: ' + e.message + ')'];
  }
}

const loaded = await waitFor(findExtension, LOAD_WAIT_MS, 'the LeadScout extension').catch(() => null);
check('extension loads and registers its service worker', !!loaded,
  'No LeadScout worker appeared after ' + targetScans + ' target scans over ' +
  Math.round((Date.now() - loadStartedAt) / 1000) + ' s. ' +
  'Extensions this browser did load: ' + (seen.join(' | ') || 'none') + '.\n       ' +
  'Browser log about extensions:\n       ' + browserLogLines().join('\n       '));
if (!loaded) { browser.close(); process.exit(3); }
const extId = loaded.id;
console.log('loaded "' + loaded.name + '" as ' + extId +
  ' (found ' + ((Date.now() - loadStartedAt) / 1000).toFixed(1) + ' s after the first look; ' +
  'the browser was left alone for its first ' + Math.round(SETTLE_MS / 1000) + ' s)');

/** Open one extension page and keep a handle on it. */
async function openPage(path, width, height) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const errors = [];
  browser.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) errors.push('exception: ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text));
  });
  browser.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid === sessionId && p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value || a.description).join(' '));
  });
  const page = {
    errors,
    async go(url) {
      const loaded = browser.once('Page.loadEventFired', sessionId);
      await browser.send('Page.navigate', { url }, sessionId);
      await loaded;
    },
    async reload() {
      const loaded = browser.once('Page.loadEventFired', sessionId);
      await browser.send('Page.reload', {}, sessionId);
      await loaded;
    },
    async eval(expression) {
      const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) {
        throw new Error('page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    async shot(file) {
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() { await browser.send('Target.closeTarget', { targetId }); }
  };
  return page;
}

/** Make downloads and clipboard writes observable instead of real. */
const HOOKS = `(() => {
  window.__t = { downloads: [], boms: [], filenames: [], clipboard: [] };
  URL.createObjectURL = (blob) => {
    blob.arrayBuffer().then(buf => {
      const b = new Uint8Array(buf);
      window.__t.boms.push(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF);
      window.__t.downloads.push(new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf));
    });
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () { window.__t.filenames.push(this.download); };
  if (navigator.clipboard) {
    navigator.clipboard.writeText = (t) => { window.__t.clipboard.push(t); return Promise.resolve(); };
  }
  return true;
})()`;

const tableState = `(() => {
  const cell = (el) => el.textContent.replace(/\\s+/g, ' ').trim();
  return {
    guard: (document.getElementById('ls-guard-banner') || {}).textContent || '',
    headers: [...document.querySelectorAll('.res-table thead th')].map(cell),
    rows: [...document.querySelectorAll('.res-table tbody tr')].map(tr => [...tr.children].map(cell)),
    summary: cell(document.getElementById('resSummary')),
    exportButtons: [...document.querySelectorAll('button[id]')].map(b => b.id),
    toast: cell(document.getElementById('toast'))
  };
})()`;

const click = (id) => `(() => { const b = document.getElementById(${JSON.stringify(id)}); if (!b) return 'missing'; b.click(); return 'clicked'; })()`;

/** A second export format, if any button still offers one. ("Full view" opens a page.) */
const isExtraFormatButton = (id) => /tsv|dlfull|fullcsv|copyfull|everyfield/i.test(id);

/** Every button the page asked to connect. An empty list means none was skipped. */
const unboundButtons = (page) => page.eval("import('./lib/ui-guard.js').then(m => m.missingBindings())");

/** What the Troubleshoot panel is showing right now. */
const troubleState = `(() => {
  const panel = document.getElementById('ls-troubleshoot');
  if (!panel) return null;
  const text = (el) => el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
  return {
    headline: text(panel.querySelector('.ls-ts-headline')),
    chips: [...panel.querySelectorAll('.ls-ts-col')].map(c => c.textContent),
    findings: [...panel.querySelectorAll('.ls-ts-item')].map(li => li.dataset.finding + ':' + li.className.replace('ls-ts-item ', '')),
    fixes: [...panel.querySelectorAll('[data-fix]')].map(b => b.dataset.fix)
  };
})()`;

const findingText = (id) => `(() => {
  const item = document.querySelector('#ls-troubleshoot [data-finding="${id}"]');
  if (!item) return null;
  const button = item.querySelector('[data-fix]');
  return { text: item.textContent.replace(/\\s+/g, ' ').trim(), fix: button ? button.dataset.fix : null };
})()`;

const closePanel = `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !document.getElementById('ls-troubleshoot'); })()`;

const pickFilter = (name) => `(() => { const c = [...document.querySelectorAll('#filterRow .chip')].find(x => x.dataset.f === ${JSON.stringify(name)}); if (!c) return false; c.click(); return true; })()`;
const activeFilter = `((document.querySelector('#filterRow .chip.active') || {}).dataset || {}).f || ''`;

async function verifyCsv(label, text, expectedRows) {
  const table = parseCsv(text);
  check(label + ': header is exactly the 10-column contract', same(table[0], CONTRACT), JSON.stringify(table[0]));
  check(label + ': every row has exactly 10 fields', table.slice(1).every(r => r.length === CONTRACT.length),
    table.slice(1).filter(r => r.length !== CONTRACT.length).map(r => r.length + ' fields').join(', '));
  check(label + ': rows and order are correct', same(table.slice(1), expectedRows),
    'got ' + JSON.stringify(table.slice(1)) + '\nwant ' + JSON.stringify(expectedRows));
}

const qaDir = join(import.meta.dirname, 'qa');
try { mkdirSync(qaDir, { recursive: true }); } catch (e) { /* screenshots are optional */ }

try {
  // ---------------------------------------------------------- popup page ----
  console.log('\n[popup]');
  const popup = await openPage('popup.html', 470, 620);
  await popup.go('chrome-extension://' + extId + '/popup.html');
  await popup.eval('chrome.storage.local.clear().then(() => chrome.storage.local.set(' +
    JSON.stringify({ job: SEED_JOB }) + '))');
  await popup.reload();
  await sleep(500);

  let s = await popup.eval(tableState);
  check('popup: no error banner is showing', !s.guard, s.guard);
  const ping = await popup.eval('chrome.runtime.sendMessage({ type: "ping" }).then(v => v || null).catch(e => ({ error: String(e) }))');
  const manifestVersion = await popup.eval('chrome.runtime.getManifest().version');
  check('background worker is alive and answers the health probe from the page',
    !!(ping && ping.ok && ping.version === manifestVersion), JSON.stringify(ping));
  check('popup: table header is exactly the 10-column contract', same(s.headers, CONTRACT), JSON.stringify(s.headers));
  check('popup: every on-screen person row reads exactly like its CSV row',
    s.rows.length === 5 && same(s.rows.slice(0, 4), EXPECTED_ROWS), JSON.stringify(s.rows));
  check('popup: a possibly-past role is not shown as a prospect (it is never exported)',
    s.rows.slice(0, 4).every(r => r[0] !== 'Old'), JSON.stringify(s.rows.map(r => r[0])));
  check('popup: the review row still has exactly 10 cells and explains itself',
    s.rows.length === 5 && s.rows[4].length === 10 && /No matching LinkedIn profiles/.test(s.rows[4][2]), JSON.stringify(s.rows[4]));
  check('popup: no TSV or full-field export button exists anywhere',
    !s.exportButtons.some(isExtraFormatButton), s.exportButtons.join(', '));
  const unbound = await unboundButtons(popup);
  check('popup: every button on the page has its handler connected', unbound.length === 0, unbound.join(', '));
  await popup.shot(join(qaDir, 'e2e-popup.png'));
  await popup.eval("document.getElementById('cardResults').scrollIntoView({ block: 'start' })");
  await sleep(250);
  await popup.shot(join(qaDir, 'e2e-popup-results.png'));

  // ---- Troubleshoot: opens, checks the real export, and its fixes work ----
  await popup.eval(click('btnTroubleshootTop'));
  await sleep(900);
  const diag = await popup.eval(troubleState);
  check('popup: Troubleshoot opens from the top bar', !!diag, 'no panel appeared');
  if (diag) {
    check('popup: Troubleshoot reports a healthy run as "Everything checks out"', /Everything checks out/.test(diag.headline), diag.headline);
    check('popup: Troubleshoot shows exactly the 10 contract columns', same(diag.chips, CONTRACT), JSON.stringify(diag.chips));
    check('popup: Troubleshoot ran the export check and found it correct (4 rows × 10 columns)',
      diag.findings.includes('export:ok'), JSON.stringify(diag.findings));
    check('popup: Troubleshoot confirms the background worker is alive', diag.findings.includes('worker:ok'),
      JSON.stringify(diag.findings));
  }
  const leftOut = await popup.eval(findingText('past-roles'));
  check('popup: Troubleshoot names the person left out as a possibly-past role',
    !!leftOut && /1 person is left out/.test(leftOut.text), JSON.stringify(leftOut));
  await popup.shot(join(qaDir, 'e2e-troubleshoot.png'));
  check('popup: Troubleshoot closes with Escape', await popup.eval(closePanel));

  await popup.eval(HOOKS);
  await popup.eval(click('btnDlCsv'));
  await sleep(400);
  let t = await popup.eval('window.__t');
  check('popup: Download CSV produces one file', t.downloads.length === 1 && t.filenames.length === 1,
    JSON.stringify(t) + '\ntoast: ' + (await popup.eval(tableState)).toast);
  if (t.downloads[0]) {
    check('popup: download is named .csv', /\.csv$/.test(t.filenames[0]), t.filenames[0]);
    check('popup: download starts with a UTF-8 byte-order mark (Excel needs it for names like José)', t.boms[0] === true);
    await verifyCsv('popup download', t.downloads[0], EXPECTED_ROWS);
  }

  await popup.eval(click('btnCopyCsv'));
  await sleep(300);
  t = await popup.eval('window.__t');
  check('popup: Copy CSV puts the CSV on the clipboard', t.clipboard.length === 1,
    'toast: ' + (await popup.eval(tableState)).toast);
  if (t.clipboard[0]) await verifyCsv('popup copy', t.clipboard[0], EXPECTED_ROWS);

  // An active filter narrows the export to the rows on screen.
  await popup.eval(pickFilter('Product'));
  await sleep(200);
  await popup.eval(click('btnDlCsv'));
  await sleep(400);
  t = await popup.eval('window.__t');
  // "Bad Link" is the one Product-category person; the others are filtered out.
  if (t.downloads[1]) await verifyCsv('popup download with the Product filter', t.downloads[1], [EXPECTED_ROWS[2]]);
  else check('popup: filtered download produces a file', false, 'no second download');

  // Troubleshoot both explains the smaller file and clears the filter for you.
  await popup.eval(click('btnTroubleshootTop'));
  await sleep(900);
  const filterFinding = await popup.eval(findingText('filter'));
  check('popup: with a filter on, Troubleshoot explains that the CSV will be smaller',
    !!filterFinding && /export follows the active filter/.test(filterFinding.text) &&
    /contain 1 of 4 people/.test(filterFinding.text), JSON.stringify(filterFinding));
  await popup.eval(`(() => { const b = document.querySelector('#ls-troubleshoot [data-finding="filter"] [data-fix]'); if (b) b.click(); return true; })()`);
  await sleep(1300); // the panel checks again by itself after a fix
  const afterFix = await popup.eval(`({ active: ${activeFilter}, stillWarned: !!document.querySelector('#ls-troubleshoot [data-finding="filter"]') })`);
  check('popup: the "Show everything again" fix really clears the filter',
    afterFix.active === 'all' && afterFix.stillWarned === false, JSON.stringify(afterFix));
  await popup.eval(closePanel);

  // ---- when nothing can be exported: no file, and the reason on screen ----
  const stuckJob = JSON.parse(JSON.stringify(SEED_JOB));
  for (const c of stuckJob.results) for (const p of c.people || []) p.currentEmployer = 'review-past';
  await popup.eval('chrome.storage.local.set(' + JSON.stringify({ job: stuckJob }) + ')');
  await popup.reload();
  await sleep(500);
  await popup.eval(HOOKS);
  await popup.eval(click('btnDlCsv'));
  await sleep(900);
  const stuck = await popup.eval(`({ downloads: window.__t.downloads.length, panel: !!document.getElementById('ls-troubleshoot') })`);
  const stuckWhy = await popup.eval(findingText('export'));
  check('popup: when nothing can be exported, no file is written and Troubleshoot opens with the reason',
    stuck.downloads === 0 && stuck.panel && !!stuckWhy && /possibly-past role/.test(stuckWhy.text),
    JSON.stringify(stuck) + ' ' + JSON.stringify(stuckWhy));
  await popup.shot(join(qaDir, 'e2e-troubleshoot-stuck.png'));
  await popup.eval(closePanel);
  // Put the normal job back for the pages that follow.
  await popup.eval('chrome.storage.local.set(' + JSON.stringify({ job: SEED_JOB }) + ')');
  await popup.reload();
  await sleep(400);

  check('popup: the research job in storage was not altered by exporting',
    same((await popup.eval('chrome.storage.local.get("job").then(v => v.job.results.length)')), 3));
  check('popup: no uncaught page errors', popup.errors.length === 0, popup.errors.join('\n'));
  await popup.close();

  // -------------------------------------------------------- results page ----
  console.log('\n[results page]');
  const results = await openPage('results.html', 1400, 900);
  await results.go('chrome-extension://' + extId + '/results.html');
  await sleep(400);
  s = await results.eval(tableState);
  check('results: no error banner is showing', !s.guard, s.guard);
  check('results: table header is exactly the 10-column contract', same(s.headers, CONTRACT), JSON.stringify(s.headers));
  check('results: every on-screen person row reads exactly like its CSV row',
    s.rows.length === 5 && same(s.rows.slice(0, 4), EXPECTED_ROWS), JSON.stringify(s.rows));
  check('results: no TSV or full-field export button exists anywhere',
    !s.exportButtons.some(isExtraFormatButton), s.exportButtons.join(', '));
  const resultsUnbound = await unboundButtons(results);
  check('results: every button on the page has its handler connected', resultsUnbound.length === 0, resultsUnbound.join(', '));
  await results.shot(join(qaDir, 'e2e-results.png'));

  await results.eval(HOOKS);
  await results.eval(click('btnDlCsv'));
  await sleep(400);
  t = await results.eval('window.__t');
  check('results: Download CSV produces one file', t.downloads.length === 1 && t.filenames.length === 1,
    JSON.stringify(t) + '\ntoast: ' + (await results.eval(tableState)).toast);
  if (t.downloads[0]) await verifyCsv('results download', t.downloads[0], EXPECTED_ROWS);

  await results.eval(click('btnCopyCsv'));
  await sleep(300);
  t = await results.eval('window.__t');
  check('results: Copy CSV puts the CSV on the clipboard', t.clipboard.length === 1,
    'toast: ' + (await results.eval(tableState)).toast);
  if (t.clipboard[0]) await verifyCsv('results copy', t.clipboard[0], EXPECTED_ROWS);

  await results.eval(click('btnTroubleshoot'));
  await sleep(900);
  const resultsPanel = await results.eval(troubleState);
  check('results: Troubleshoot opens and passes the export check on this page too',
    !!resultsPanel && /Everything checks out/.test(resultsPanel.headline) && resultsPanel.findings.includes('export:ok'),
    JSON.stringify(resultsPanel));
  await results.eval(closePanel);
  check('results: no uncaught page errors', results.errors.length === 0, results.errors.join('\n'));
  await results.close();

  // ---------------------------------------------------------- side panel ----
  console.log('\n[side panel]');
  const panel = await openPage('sidepanel.html', 900, 700);
  await panel.go('chrome-extension://' + extId + '/sidepanel.html');
  await panel.eval('chrome.storage.local.set(' + JSON.stringify({ 'workspace.rows': SEED_ROWS }) + ')');
  await panel.reload();
  await sleep(400);
  const panelState = await panel.eval(`(() => {
    const cell = (el) => el.textContent.replace(/\\s+/g, ' ').trim();
    return {
      guard: (document.getElementById('ls-guard-banner') || {}).textContent || '',
      headers: [...document.querySelectorAll('thead th')].map(cell),
      rowWidths: [...document.querySelectorAll('tbody tr')].map(tr => tr.children.length),
      buttons: [...document.querySelectorAll('button')].filter(b => b.id).map(b => b.id)
    };
  })()`);
  check('side panel: no error banner is showing', !panelState.guard, panelState.guard);
  check('side panel: table header is exactly the 10-column contract', same(panelState.headers, CONTRACT),
    JSON.stringify(panelState.headers));
  check('side panel: every row has exactly 10 cells — no actions column',
    panelState.rowWidths.length === 2 && panelState.rowWidths.every(n => n === CONTRACT.length),
    JSON.stringify(panelState.rowWidths));
  check('side panel: no TSV button exists', !panelState.buttons.some(id => /tsv/i.test(id)), panelState.buttons.join(', '));
  await panel.shot(join(qaDir, 'e2e-sidepanel.png'));

  await panel.eval(HOOKS);
  await panel.eval(click('btnCsv'));
  await sleep(400);
  t = await panel.eval('window.__t');
  check('side panel: CSV produces one file', t.downloads.length === 1 && /\.csv$/.test(t.filenames[0] || ''),
    JSON.stringify(t) + '\ntoast: ' + (await panel.eval('document.getElementById("toast").textContent')));
  if (t.downloads[0]) await verifyCsv('side panel download', t.downloads[0], EXPECTED_WORKSPACE_ROWS);

  // Deleting a row must still work now that there is no actions column.
  await panel.eval(`(() => { const b = document.querySelector('tbody tr .rowdel'); if (!b) return false; b.click(); return true; })()`);
  await sleep(300);
  const afterDelete = await panel.eval('document.querySelectorAll("tbody tr").length');
  check('side panel: a row can still be deleted from inside the last cell', afterDelete === 1, afterDelete + ' rows left');

  const panelUnbound = await unboundButtons(panel);
  check('side panel: every button on the page has its handler connected', panelUnbound.length === 0, panelUnbound.join(', '));
  await panel.eval(click('btnTroubleshoot'));
  await sleep(900);
  const panelDiag = await panel.eval(troubleState);
  check('side panel: Troubleshoot opens and checks the workspace export',
    !!panelDiag && panelDiag.findings.includes('export:ok'), JSON.stringify(panelDiag));
  check('side panel: no uncaught page errors', panel.errors.length === 0, panel.errors.join('\n'));
  await panel.close();
} catch (e) {
  check('the run completed without a harness error', false, e && e.message);
} finally {
  browser.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
