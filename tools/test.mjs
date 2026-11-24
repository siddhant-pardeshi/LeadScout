// LeadScout logic tests — run with: node tools/test.mjs
import assert from 'node:assert/strict';
import {
  parseInputs, slugFromUrl, titleCaseSlug, decodeBingUrl, parseProfileTitle,
  linkedinHandle, companyMatch, companyMatchPartial, domainFromWebsite, emailFor,
  buildTSV, buildCSV, extractSizeFromText, overlapTokens, kebabName, slugScore,
  looseResolveMatch, roleCurrency, matchHunterEmail, cell, nameEvidence
} from '../lib/parse.js';
import { classifyDesignation, seniorityBonus } from '../lib/rank.js';
import { extractJson, assertSafeUrl } from '../lib/ai.js';
import {
  KEY_PROVIDERS, emptyKeyMeta, normalizeKeyMeta, isDateStr, localDateStr,
  daysLeft, keyStatus, fmtDate, maskKey
} from '../lib/keys.js';

let passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '  → ' + e.message); }
}

// ---------------- input parsing ----------------
T('parseInputs: url / name / mixed lines dedupe', () => {
  const items = parseInputs(
    'https://www.linkedin.com/company/zoho/\n' +
    'https://www.linkedin.com/company/zoho/\n' +
    'Freshworks\n' +
    'Postman - https://www.linkedin.com/company/postman-platform/\n' +
    '* - Bullet Co\n' +
    '');
  assert.equal(items.length, 4);
  assert.equal(items[0].type, 'url');
  assert.equal(items[0].slug, 'zoho');
  assert.equal(items[1].type, 'name');
  assert.equal(items[1].name, 'Freshworks');
  assert.equal(items[2].type, 'url');
  assert.equal(items[2].name, 'Postman');   // name kept from "Name - URL" line
  assert.equal(items[3].type, 'name');
  assert.equal(items[3].name, 'Bullet Co'); // bullet markers stripped
});

T('slugFromUrl variants', () => {
  assert.equal(slugFromUrl('https://www.linkedin.com/company/acme-corp/'), 'acme-corp');
  assert.equal(slugFromUrl('https://in.linkedin.com/company/acme/about'), 'acme');
  assert.equal(slugFromUrl('https://example.com/x'), null);
  assert.equal(slugFromUrl(''), null);
});

T('titleCaseSlug', () => {
  assert.equal(titleCaseSlug('postman-platform'), 'Postman Platform');
  assert.equal(titleCaseSlug('freshworks'), 'Freshworks');
});

// ---------------- Bing title parsing ----------------
T('parseProfileTitle: classic SERP title', () => {
  const r = parseProfileTitle('Jane Doe - Chief Technology Officer - Acme Corp | LinkedIn');
  assert.equal(r.name, 'Jane Doe');
  assert.equal(r.designation, 'Chief Technology Officer');
});

T('parseProfileTitle: "Founder & CEO at Acme"', () => {
  const r = parseProfileTitle('John Smith - Founder & CEO at Acme | LinkedIn');
  assert.equal(r.name, 'John Smith');
  assert.equal(r.designation, 'Founder & CEO');
});

T('parseProfileTitle: junk rows rejected', () => {
  assert.equal(parseProfileTitle('1,234 followers - LinkedIn'), null);
  assert.equal(parseProfileTitle('Jane on LinkedIn: Big news!!'), null);
  assert.equal(parseProfileTitle('Sign Up | LinkedIn'), null);
});

T('parseProfileTitle RC4: affiliation-only title → designation empty, not the company', () => {
  const r = parseProfileTitle('John Smith - Acme Corp | LinkedIn');
  assert.ok(r, 'should keep the person');
  assert.equal(r.name, 'John Smith');
  assert.equal(r.designation, '');      // v1.0 put "Acme Corp" here — wrong
});

T('parseProfileTitle RC4: single-segment "Jane Doe CEO at Acme"', () => {
  const r = parseProfileTitle('Jane Doe CEO at Acme | LinkedIn');
  assert.ok(r, 'should parse');
  assert.equal(r.name, 'Jane Doe');
  assert.equal(r.designation, 'CEO');
});

T('parseProfileTitle: title keyword inside 3-part row', () => {
  const r = parseProfileTitle('Sarah Chen - Head of Machine Learning - InMobi | LinkedIn');
  assert.equal(r.name, 'Sarah Chen');
  assert.equal(r.designation, 'Head of Machine Learning');
});

T('extractSizeFromText RC5: snippet size recovery', () => {
  assert.equal(extractSizeFromText('Acme Corp | 5,001-10,000 employees | LinkedIn'), '5,001-10,000 employees');
  assert.equal(extractSizeFromText('...201 to 500 employees worldwide...'), '201-500 employees');
  assert.equal(extractSizeFromText('over 200 employees across offices'), '200 employees');
  assert.equal(extractSizeFromText('no size here'), null);
  assert.equal(extractSizeFromText(''), null);
});

T('linkedinHandle', () => {
  assert.equal(linkedinHandle('https://www.linkedin.com/in/jane-doe-1234/'), 'jane-doe-1234');
  assert.equal(linkedinHandle('https://www.linkedin.com/company/acme/'), null);
});

T('decodeBingUrl: ck/a redirect + passthrough', () => {
  const real = 'https://linkedin.com/in/jane-doe-1234/';
  const b64 = Buffer.from('a1' + Buffer.from(real).toString('base64url').slice(0)).toString('base64url');
  // emulate: strip leading 'a1' after decode — construct like Bing does
  const payload = 'a1' + Buffer.from(real).toString('base64url');
  const url = 'https://www.bing.com/ck/a?!&&p=xx&u=' + payload;
  const dec = decodeBingUrl(url);
  assert.equal(dec, real);
  assert.equal(decodeBingUrl('https://www.linkedin.com/in/direct/'), 'https://www.linkedin.com/in/direct/');
});

// ---------------- company matching (anti-bleed) ----------------
T('companyMatch: matches tokens, ignores filler', () => {
  assert.equal(companyMatch('CTO at Acme Corp Ltd | LinkedIn', 'Acme Corp'), true);
  assert.equal(companyMatch('CTO at Beta Corp | LinkedIn', 'Acme Corp'), false);
  assert.equal(companyMatch('Jane Doe - CEO - Zoho | LinkedIn', 'Zoho'), true);
  assert.equal(companyMatch('engineer at Zoho Corporation', 'Zoho'), true);
  assert.equal(companyMatch('random text', 'Zoho'), false);
});

// ---- name-mode resolution fixes (v1.2) ----
T('looseResolveMatch: legal name vs short LinkedIn title (the v1.1 killer case)', () => {
  // "Zoho Corporation" typed; LinkedIn page titled "Zoho | LinkedIn"
  assert.equal(looseResolveMatch('Zoho | LinkedIn', 'Zoho - software company', 'zoho', 'Zoho Corporation'), 1);
  assert.ok(looseResolveMatch('Zoho | LinkedIn', '', 'zoho', 'Zoho Corporation') >= 1);
});

T('looseResolveMatch: strong and reject tiers', () => {
  assert.equal(looseResolveMatch('Freshworks | LinkedIn', 'SaaS company', 'freshworks', 'Freshworks'), 2);
  assert.equal(looseResolveMatch('Tata Consultancy Services | LinkedIn', '', 'tata-consultancy-services', 'Tata Consultancy Services'), 2);
  assert.equal(looseResolveMatch('Unrelated Page', 'nothing here', 'unrelated', 'Zoho Corporation'), 0);
});

T('kebabName + overlapTokens + slugScore', () => {
  assert.equal(kebabName('Tata Consultancy Services'), 'tata-consultancy-services');
  assert.equal(kebabName('R&D & Innovation Co.'), 'r-and-d-and-innovation-co');
  assert.equal(overlapTokens('Zoho', 'zoho corporation pvt ltd'), 1);
  assert.equal(overlapTokens('Unrelated Corp', 'Zoho Corporation'), 0);
  assert.equal(slugScore('freshworks', 'Freshworks'), 3);
  assert.equal(slugScore('tata-consultancy-services', 'Tata Consultancy Services'), 9);
});

T('companyMatchPartial: recall fallback for unresolved names', () => {
  // profile says "at Zoho", typed name was "Zoho Corporation"
  assert.equal(companyMatchPartial('CEO at Zoho | LinkedIn', 'Zoho Corporation'), true);
  assert.equal(companyMatchPartial('CTO at Freshworks Inc', 'Freshworks'), true);
  assert.equal(companyMatchPartial('random engineer', 'Zoho Corporation'), false);
  // legal suffixes are FILLER — "Zoho" and "Zoho Corporation" are the same company
  assert.equal(companyMatch('CEO at Zoho | LinkedIn', 'Zoho Corporation'), true);
  // strict matcher still rejects a DIFFERENT company
  assert.equal(companyMatch('CTO at Zylker | LinkedIn', 'Zoho Corporation'), false);
  // the real-world v1.1 killer: typed "X Technologies", page titled "X"
  assert.equal(companyMatch('Nuclearis | LinkedIn', 'Nuclearis Technologies'), true);
  assert.equal(companyMatch('Sr Dev at Paytm Pvt Ltd', 'Paytm'), true);
});

// ---------------- designation engine ----------------
T('classifyDesignation priorities', () => {
  const ceo = classifyDesignation('Founder & CEO');
  assert.equal(ceo.cat, 'C-Suite');
  assert.equal(ceo.pri, 1);
  const cto = classifyDesignation('Chief Technology Officer');
  assert.equal(cto.pri, 1);
  const vpEng = classifyDesignation('VP of Engineering');
  assert.equal(vpEng.cat, 'Engineering');
  assert.equal(vpEng.pri, 2);
  const ai = classifyDesignation('Head of Artificial Intelligence');
  assert.equal(ai.cat, 'AI & Automation');
  const pm = classifyDesignation('Product Manager');
  assert.equal(pm.pri, 4);
  assert.ok(classifyDesignation('Coffee taste tester').sc >= 0);
});

T('seniorityBonus', () => {
  assert.ok(seniorityBonus('Chief Technology Officer') > seniorityBonus('Engineer'));
});

// ---------------- emails ----------------
T('domainFromWebsite', () => {
  assert.equal(domainFromWebsite('https://www.acme.io/products'), 'acme.io');
  assert.equal(domainFromWebsite('acme.io'), 'acme.io');
  assert.equal(domainFromWebsite('https://gmail.com'), null);
  assert.equal(domainFromWebsite('not a url'), null);
});

T('emailFor patterns + flag', () => {
  const e = emailFor('José García', 'acme.io');
  assert.equal(e.email, 'jose.garcia@acme.io');
  assert.match(e.status, /estimated/);
  assert.ok(e.alternates.includes('jgarcia@acme.io'));
  assert.equal(emailFor('Jane', null), null);
});

// ---------------- AI JSON plumbing ----------------
T('extractJson from noisy reply', () => {
  const txt = 'Here you go:\n```json\n{"company":{"industry":"IT"},"people":[{"name":"A"}]}\n```';
  const j = JSON.parse(extractJson(txt));
  assert.equal(j.company.industry, 'IT');
  assert.equal(j.people.length, 1);
});

T('assertSafeUrl rejects private/localhost, allows https', () => {
  assert.throws(() => assertSafeUrl('http://localhost:8080/v1'));
  assert.throws(() => assertSafeUrl('http://127.0.0.1:11434/v1'));
  assert.throws(() => assertSafeUrl('http://192.168.1.10/v1'));
  assert.throws(() => assertSafeUrl('http://169.254.169.254/v1'));
  assert.throws(() => assertSafeUrl('file:///etc/passwd'));
  assert.equal(assertSafeUrl('https://api.groq.com/openai/v1/chat/completions').startsWith('https://'), true);
  assert.equal(assertSafeUrl('http://api.example.com/v1').startsWith('http://'), true);
});

// ---------------- exports ----------------
T('cell strips tabs/newlines', () => {
  assert.equal(cell('A\tB\nC'), 'A B C');
});

T('buildTSV: header + rows + review row + full columns', () => {
  const comps = [{
    name: 'Acme Corp', country: 'India', size: '201-500 employees',
    industry: 'Software Development', url: 'https://www.linkedin.com/company/acme/',
    people: [
      { name: 'Jane Doe', designation: 'Chief Technology Officer', url: 'https://www.linkedin.com/in/jane/', urlVerified: true, currentEmployer: 'current', pri: 1, score: 110, priority: 'P1', email: 'jane.doe@acme.io', emailStatus: 'estimated — unverified' },
      { name: 'Bob Lee', designation: 'Head of Product', url: '', urlVerified: false, pri: 2, score: 90, priority: 'P2' }
    ]
  }, {
    name: 'Empty Co', people: [], url: ''
  }];
  const full = buildTSV(comps, { core: false });
  const lines = full.split('\n');
  assert.equal(lines[0].split('\t').length, 14);
  assert.ok(lines[1].includes('Jane Doe'));
  assert.ok(lines[1].includes('Verified'));
  assert.ok(lines[2].includes('Unverified'));
  assert.ok(full.includes('Empty Co'));
  assert.ok(full.includes('needs manual review'));

  const core = buildTSV(comps, { core: true });
  assert.equal(core.split('\n')[0].split('\t').length, 7);
});

T('buildCSV quotes commas properly', () => {
  const comps = [{
    name: 'Acme, Inc.', country: '', size: '', industry: '', url: '',
    people: [{ name: 'A B', designation: 'CTO', url: '', urlVerified: false, pri: 1, score: 1, priority: 'P1' }]
  }];
  const csv = buildCSV(comps, { core: true });
  assert.ok(csv.includes('"Acme, Inc."'));
});

// ---- v1.3 role currency (latest designation, not past) ----
T('roleCurrency: title-verified current role', () => {
  assert.equal(roleCurrency(true, false, 'John Smith - CEO at Acme | LinkedIn', '', 'Acme Corp'), 'current');
  assert.equal(roleCurrency(true, true, 'John Smith - CEO at Acme | LinkedIn',
    'Acme Corp is a software company', 'Acme Corp'), 'current');
});

T('roleCurrency: past-role markers drop snippet-only matches', () => {
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'Jane Doe. Former CEO at Acme Corp', 'Acme Corp'), 'past');
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'Jane was CTO of Acme Corp', 'Acme Corp'), 'past');
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'Ex-Founder of Acme Corp', 'Acme Corp'), 'past');
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'She previously worked at Acme Corp', 'Acme Corp'), 'past');
});

T('roleCurrency: company named BEFORE marker = current; after marker = past', () => {
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'Acme Corp engineer, previously at Google', 'Acme Corp'), 'snippet');
  assert.equal(roleCurrency(false, true, 'Jane Doe | LinkedIn',
    'Previously at Google, now CTO at Acme Corp', 'Acme Corp'), 'snippet');
});

T('roleCurrency: current-role titles survive past mentions elsewhere in snippet', () => {
  // headline is about Acme now; "previously" refers to an older job elsewhere
  assert.equal(roleCurrency(true, true, 'John Smith - CTO at Acme | LinkedIn',
    'Previously at Google. Acme Corp CTO', 'Acme Corp'), 'review-past');
});

T('roleCurrency: current titles are NOT marked past by "Founder"', () => {
  assert.equal(roleCurrency(true, false, 'John Smith - Founder & CEO at Acme | LinkedIn', '', 'Acme Corp'), 'current');
});

// ---- v1.4.1 AI corpus-grounding gate ----
T('nameEvidence: grounded current role in the company corpus', () => {
  const serp = [
    { title: 'Jane Doe - CTO - Acme Corp | LinkedIn', snippet: 'Jane Doe is the CTO of Acme Corp.' },
    { title: 'Bob Lee - VP Engineering - Acme Corp | LinkedIn', snippet: '' }
  ];
  const e = nameEvidence('Jane Doe', serp, 'Acme Corp');
  assert.equal(e.index, 0);
  assert.equal(e.role, 'current');
});

T('nameEvidence: model-invented or single-token names never pass', () => {
  const serp = [{ title: 'Jane Doe - CTO - Acme Corp | LinkedIn', snippet: '' }];
  assert.equal(nameEvidence('Mallory Ghost', serp, 'Acme Corp'), null);
  assert.equal(nameEvidence('Jane', serp, 'Acme Corp'), null);
});

T('nameEvidence: name from another company is rejected', () => {
  const serp = [{ title: 'Jane Doe - CTO - Globex | LinkedIn', snippet: '' }];
  assert.equal(nameEvidence('Jane Doe', serp, 'Acme Corp'), null);
});

T('nameEvidence: past role before the company is rejected', () => {
  const serp = [{ title: 'Jane Doe | LinkedIn', snippet: 'Former CTO at Acme Corp.' }];
  assert.equal(nameEvidence('Jane Doe', serp, 'Acme Corp'), null);
});

T('nameEvidence: prefers the current mention over a past one', () => {
  const serp = [
    { title: 'Jane Doe | LinkedIn', snippet: 'Former CTO at Acme Corp.' },
    { title: 'Jane Doe - CTO - Acme Corp | LinkedIn', snippet: '' }
  ];
  const e = nameEvidence('Jane Doe', serp, 'Acme Corp');
  assert.equal(e.index, 1);
  assert.equal(e.role, 'current');
});

T('nameEvidence: punctuation and name particles are tolerated', () => {
  const serp = [{ title: "Anne-Marie O'Neil - Head of AI - Acme | LinkedIn", snippet: '' }];
  const e = nameEvidence("Anne-Marie O'Neil", serp, 'Acme');
  assert.equal(e.role, 'current');
});

// ---- v1.5 API key vault ----
T('keys: default schema covers every provider', () => {
  const meta = emptyKeyMeta();
  assert.deepEqual(Object.keys(meta).sort(), [...KEY_PROVIDERS].sort());
  assert.equal(meta.groq.expiresAt, '');
  assert.equal(meta.hunter.lastCheckOk, null);
});

T('keys: normalize drops junk and fills missing fields', () => {
  const n = normalizeKeyMeta({
    groq: { savedAt: '2026-11-24', expiresAt: 'nope', lastCheckOk: true },
    hunter: { expiresAt: '2026-12-31' }
  });
  assert.equal(n.groq.savedAt, '2026-11-24');
  assert.equal(n.groq.expiresAt, '');
  assert.equal(n.groq.lastCheckOk, true);
  assert.equal(n.hunter.expiresAt, '2026-12-31');
  assert.equal(n.gemini.savedAt, '');
});

T('keys: calendar-day math across today/tomorrow/yesterday', () => {
  const now = new Date(2026, 10, 24, 10, 0, 0).getTime();
  assert.equal(daysLeft('2026-11-24', now), 0);
  assert.equal(daysLeft('2026-11-25', now), 1);
  assert.equal(daysLeft('2026-11-23', now), -1);
  assert.equal(daysLeft('not-a-date', now), null);
});

T('keys: status labels for none/active/soon/expired', () => {
  const now = new Date(2026, 10, 24, 10, 0, 0).getTime();
  assert.equal(keyStatus({}, now).state, 'none');
  assert.equal(keyStatus({ expiresAt: '2027-01-10' }, now).state, 'active');
  assert.equal(keyStatus({ expiresAt: '2026-12-10' }, now).state, 'soon');
  assert.equal(keyStatus({ expiresAt: '2026-11-20' }, now).state, 'expired');
  assert.match(keyStatus({ expiresAt: '2026-11-20' }, now).label, /4 days ago/);
  assert.equal(keyStatus({ expiresAt: '2026-11-24' }, now).label, 'Expires today');
});

T('keys: date validation rejects impossible dates', () => {
  assert.equal(isDateStr('2026-11-24'), true);
  assert.equal(isDateStr('2026-02-29'), false);
  assert.equal(isDateStr('24-11-2026'), false);
});

T('keys: local dates and display dates use the local calendar', () => {
  const d = new Date(2026, 0, 5, 23, 30, 0);
  assert.equal(localDateStr(d.getTime()), '2026-01-05');
  assert.equal(fmtDate('2026-11-24'), '24 Nov 2026');
  assert.equal(fmtDate('bad'), '');
});

T('keys: mask never exposes a full key', () => {
  const k = 'gsk_1234567890abcdef';
  const m = maskKey(k);
  assert.ok(!m.includes(k));
  assert.equal(m, 'gsk_…cdef');
  assert.equal(maskKey('short'), '••••');
  assert.equal(maskKey(''), '');
});

// ---- v1.3 Hunter.io email matching ----
T('matchHunterEmail: exact name match', () => {
  const r = matchHunterEmail('Jane Doe', [
    { value: 'jane.doe@acme.io', first_name: 'Jane', last_name: 'Doe', position: 'CTO' }
  ], null, 'acme.io');
  assert.equal(r.email, 'jane.doe@acme.io');
  assert.match(r.status, /verified via Hunter/);
});

T('matchHunterEmail: local-part fallback match', () => {
  const r = matchHunterEmail('José García', [
    { value: 'jgarcia@acme.io', first_name: '', last_name: '', position: '' }
  ], null, 'acme.io');
  assert.equal(r.email, 'jgarcia@acme.io');
});

T('matchHunterEmail: domain-verified pattern fallback', () => {
  const r = matchHunterEmail('Jane Doe', [], '{first}.{last}', 'acme.io');
  assert.equal(r.email, 'jane.doe@acme.io');
  assert.match(r.status, /pattern from Hunter/);
});

T('matchHunterEmail: no match → null (pattern estimation takes over)', () => {
  assert.equal(matchHunterEmail('Jane Doe', [], null, null), null);
});

// ---- v1.3 export columns ----
T('buildTSV v1.3: 14 columns incl. Role Currency + HQ', () => {
  const comps = [{
    name: 'Acme Corp', country: 'India', hq: 'Bengaluru, Karnataka, India',
    size: '201-500 employees', industry: 'Software Development',
    url: 'https://www.linkedin.com/company/acme/',
    people: [{ name: 'Jane Doe', designation: 'CTO', url: 'https://www.linkedin.com/in/jane/',
      urlVerified: true, currentEmployer: 'current', pri: 1, score: 110, priority: 'P1',
      email: 'jane.doe@acme.io', emailStatus: 'verified via Hunter.io' }]
  }];
  const full = buildTSV(comps, { core: false });
  const head = full.split('\n')[0].split('\t');
  assert.equal(head.length, 14);
  assert.equal(head[9], 'Role Currency');
  assert.equal(head[12], 'HQ');
  const row = full.split('\n')[1].split('\t');
  assert.equal(row[9], 'Current');
  const core = buildTSV(comps, { core: true });
  assert.equal(core.split('\n')[0].split('\t').length, 7); // user's original template
});

// ---- v1.4.1 ESM link check (reproduces Chrome "status code: 15") ----
// Plain node --check is parse-only and cannot see import-binding conflicts
// (e.g. a local function shadowing an imported name). Importing the entry
// files with the real module loader does. Anything other than hitting a
// browser-only global (chrome/document/…) is fatal.
const BENIGN_RE = /\b(chrome|document|window|localStorage|navigator|location|URL|fetch|AbortController|crypto)\s+is not defined\b/i;
const ENTRIES = ['../background.js', '../popup.js', '../results.js'];

await (async function linkCheck() {
  const name = 'ESM link check: background/popup/results import chains';
  try {
    for (const entry of ENTRIES) {
      const url = new URL(entry, import.meta.url).href;
      try {
        await import(url);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!BENIGN_RE.test(msg)) {
          throw new Error(entry + ' → ' + msg.split('\n')[0]);
        }
      }
    }
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '  → ' + e.message);
  }
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
