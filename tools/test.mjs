// LeadScout logic tests — run with: node tools/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseInputs, slugFromUrl, titleCaseSlug, decodeBingUrl, parseProfileTitle,
  linkedinHandle, companyMatch, companyMatchPartial, domainFromWebsite, emailFor,
  buildCSV, buildTSV, splitProspectName, CRM_EXPORT_HEADERS, FULL_EXPORT_HEADERS, extractSizeFromText, overlapTokens, kebabName, slugScore,
  looseResolveMatch, roleCurrency, matchHunterEmail, cell, exportCell, nameEvidence,
  officialLeadershipCandidate, inferWebsiteFromSerp, officialPageCandidate, classifyOutcome,
  domainMatchesCompany, websiteCandidates, companyFactsFromPage, resolveTargets,
  linkedinUrlForExport
} from '../lib/parse.js';
import {
  RECORD_FIELDS, RESOLVE_STATUS, emptyRecord, normalizeRecord, recordKey, mergeRecords,
  recordRow, recordsToCSV, recordsToTSV, linkedinSearchQuery, verifySearchUrl,
  needsResolution, parseSelectionText, isBlankRecord,
  linkedinSearchQueries, pickProfileResult, companyToken
} from '../lib/records.js';
import { classifyDesignation, seniorityBonus } from '../lib/rank.js';
import { extractJson, assertSafeUrl } from '../lib/ai.js';
import { extractBingResults, extractOfficialLeadership, extractLinkedInCompany } from '../lib/extract.js';
import {
  KEY_PROVIDERS, emptyKeyMeta, normalizeKeyMeta, isDateStr, localDateStr,
  daysLeft, keyStatus, fmtDate, maskKey
} from '../lib/keys.js';

let passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '  → ' + e.message); }
}

const CRM_EXPORT_CONTRACT = [
  'PROSPECT_FIRST_NAME', 'PROSPECT_LAST_NAME', 'DESIGNATION', 'EMAIL_ID',
  'COMPANY_NAME', 'COMPANY_SIZE', 'COUNTRY', 'INDUSTRY_TYPE', 'WEBSITE_NAME',
  'LINKEDIN_URL'
];

T('manifest: optional host permissions are not redundant with required hosts', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const required = new Set(manifest.host_permissions || []);
  const optional = manifest.optional_host_permissions || [];
  assert.deepEqual(optional.filter(pattern => required.has(pattern)), []);
  assert.ok(optional.includes('http://*/*'));
});

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

T('extractBingResults: profile anchors survive generic-result-heavy Bing markup', () => {
  const profileUrl = 'https://www.linkedin.com/in/asha-shah-123/';
  const wrappedProfileUrl = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(profileUrl).toString('base64url');
  const genericCard = (n) => ({
    querySelector(selector) {
      if (selector === 'h2 a' || selector === 'a[href]') {
        return { innerText: 'Generic result ' + n, href: 'https://example.com/' + n };
      }
      if (selector.indexOf('b_caption') !== -1 || selector === 'p') return { innerText: 'Generic result text' };
      return null;
    }
  });
  let profileCard;
  const profileAnchor = {
    href: wrappedProfileUrl,
    innerText: 'Asha Shah - Chief Technology Officer - Acme Corp | LinkedIn',
    closest() { return profileCard; },
    parentElement: null
  };
  profileCard = {
    innerText: 'Asha Shah - Chief Technology Officer - Acme Corp | LinkedIn',
    querySelector(selector) {
      if (selector === 'h2 a' || selector === 'h2') return profileAnchor;
      return null;
    }
  };
  const fakeDocument = {
    title: 'Bing results',
    body: { innerText: 'Search results', innerHTML: '' },
    querySelector(selector) { return selector === '#b_results' ? {} : null; },
    querySelectorAll(selector) {
      if (selector === '#b_results li.b_algo') return [genericCard(1), genericCard(2), genericCard(3)];
      if (selector === 'a[href]') return [profileAnchor];
      return [];
    }
  };
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const oldLocation = globalThis.location;
  globalThis.document = fakeDocument;
  globalThis.location = { href: 'https://www.bing.com/search?q=acme' };
  try {
    const out = extractBingResults();
    assert.equal(out.standardResultCount, 3);
    assert.equal(out.profileResultCount, 1);
    assert.ok(out.results.some(result => result.url === profileUrl));
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
    if (hadLocation) globalThis.location = oldLocation; else delete globalThis.location;
  }
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

T('official leadership source: accepts explicit current role only on company domain', () => {
  const lead = officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Acme Corp leadership team',
    snippet: 'Meet the Acme leadership team.',
    url: 'https://www.acme.example/leadership'
  }, 'https://acme.example', 'Acme Corp');
  assert.ok(lead);
  assert.equal(lead.name, 'Asha Shah');
  assert.equal(lead.designation, 'Chief Technology Officer');
  assert.equal(lead.evidenceUrl, 'https://www.acme.example/leadership');
  assert.equal(officialLeadershipCandidate({
    title: 'Asha Shah - Former Chief Technology Officer - Acme Corp',
    snippet: '', url: 'https://acme.example/news'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Acme Corp',
    snippet: 'Acme Corp leadership team', url: 'https://lookalike.example/leadership'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Acme Corp',
    snippet: 'Acme Corp announced this appointment in 2018.',
    url: 'https://acme.example/news/asha-shah-appointment'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Acme Corp leadership team',
    snippet: 'Acme Corp leadership team',
    url: 'https://acme.example/press-releases/2018/asha-shah'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Bina Lee - Chief Technology Officer - Beta Division leadership team',
    snippet: 'Beta Division leadership team', url: 'https://acme.example/leadership'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Acme Corp leadership team',
    snippet: '', url: 'ftp://acme.example/leadership'
  }, 'https://acme.example', 'Acme Corp'), null);
  assert.equal(officialLeadershipCandidate({
    title: 'Charlie Bell - Vice President, Engineer - Microsoft - Acme Board of Directors',
    snippet: 'Acme Board of Directors', url: 'https://acme.example/board-of-directors'
  }, 'https://acme.example', 'Acme'), null);
  const legalVariant = officialLeadershipCandidate({
    title: 'Asha Shah - Chief Technology Officer - Godrej Industries leadership team',
    snippet: 'Godrej Industries leadership team', url: 'https://godrej.example/leadership'
  }, 'https://godrej.example', 'Godrej Industries Group');
  assert.equal(legalVariant.name, 'Asha Shah');
});

T('inferWebsiteFromSerp: company homepage, not directories or lookalikes', () => {
  const serp = [
    { title: 'Twilio - Wikipedia', url: 'https://en.wikipedia.org/wiki/Twilio' },
    { title: 'Conversational AI and APIs | Twilio', url: 'https://www.twilio.com/en-us' },
    { title: 'Twilio login', url: 'https://login.twilio.com/' }
  ];
  const site = inferWebsiteFromSerp(serp, 'Twilio');
  assert.equal(site.url, 'https://twilio.com/');
  assert.equal(site.host, 'twilio.com');
  assert.equal(inferWebsiteFromSerp([{ title: 'Twilio', url: 'https://www.linkedin.com/company/twilio/' }], 'Twilio'), null);
  assert.equal(inferWebsiteFromSerp([{ title: 'Twilio', url: 'https://twilio-login.example/phish' }], 'Twilio'), null);
  assert.equal(inferWebsiteFromSerp([{ title: 'Acme Corp', url: 'https://www.acme.com/' }], 'Acme Corp').host, 'acme.com');
});

T('inferWebsiteFromSerp: prefers the specific company domain', () => {
  const site = inferWebsiteFromSerp([
    { title: 'Godrej', url: 'https://godrej.com/' },
    { title: 'Godrej Industries', url: 'https://godrejindustries.com/' }
  ], 'Godrej Industries Group');
  assert.equal(site.host, 'godrejindustries.com');
});

T('websiteCandidates/domainMatchesCompany: Indian company domains', () => {
  assert.deepEqual(websiteCandidates('Jio-bp').slice(0, 2), ['https://jiobp.com/', 'https://jio.com/']);
  assert.ok(websiteCandidates('SUN PHARMA').includes('https://sunpharma.com/'));
  assert.ok(websiteCandidates('Godrej Industries Group').includes('https://godrejindustries.com/'));
  assert.equal(domainMatchesCompany('sunpharma.com', 'SUN PHARMA'), true);
  assert.equal(domainMatchesCompany('jiobp.com', 'Jio-bp'), true);
  assert.equal(domainMatchesCompany('godrej.com', 'Godrej Industries Group'), false);
  assert.equal(domainMatchesCompany('godrejindustries.com', 'Godrej Industries Group'), true);
  assert.equal(domainMatchesCompany('redingtongroup.com', 'Redington'), true);
});

T('officialPageCandidate: legal-name domain trust and homepage leadership cards', () => {
  const sun = officialPageCandidate({
    name: 'DILIP SHANGHVI', role: 'Executive Chairman', section: 'Board of Directors',
    pageTitle: 'Board of Directors | Sun Pharmaceutical Industries Limited',
    url: 'https://sunpharma.com/board-of-directors', evidence: 'DILIP SHANGHVI Executive Chairman'
  }, 'https://sunpharma.com/', 'SUN PHARMA');
  assert.ok(sun);
  assert.equal(sun.designation, 'Executive Chairman');
  const welspun = officialPageCandidate({
    name: 'BALKRISHAN GOENKA', role: 'Chairman, Welspun World', section: 'Awards & Recognitions',
    pageTitle: 'Globally recognized leaders in Home Textiles and Line Pipes',
    url: 'https://www.welspun.com/',
    evidence: 'OUR LEADERSHIP Who Leads The Way Towards Excellence BALKRISHAN GOENKA Chairman, Welspun World'
  }, 'https://www.welspun.com/', 'Welspun World');
  assert.ok(welspun);
  assert.equal(officialPageCandidate({
    name: 'Charlie Bell', role: 'Executive Vice President, Engineer, Microsoft',
    section: 'Board of Directors', pageTitle: 'Twilio Leadership Team | Twilio',
    url: 'https://www.twilio.com/en-us/company/leadership', evidence: ''
  }, 'https://www.twilio.com/', 'Twilio'), null);
});

T('officialPageCandidate: keeps a profile link found on the company page, never claims it verified', () => {
  const sun = officialPageCandidate({
    name: 'DILIP SHANGHVI', role: 'Executive Chairman', section: 'Board of Directors',
    pageTitle: 'Board of Directors | Sun Pharmaceutical Industries Limited',
    url: 'https://sunpharma.com/board-of-directors', evidence: 'DILIP SHANGHVI Executive Chairman',
    profileUrl: 'https://www.linkedin.com/in/dilip-shanghvi/?trk=footer'
  }, 'https://sunpharma.com/', 'SUN PHARMA');
  assert.ok(sun);
  assert.equal(sun.profileUrl, 'https://www.linkedin.com/in/dilip-shanghvi/');
  assert.equal(sun.sourceType, 'official', 'role evidence stays official');

  const companyPage = officialPageCandidate({
    name: 'DILIP SHANGHVI', role: 'Executive Chairman', section: 'Board of Directors',
    pageTitle: 'Board of Directors | Sun Pharmaceutical Industries Limited',
    url: 'https://sunpharma.com/board-of-directors', evidence: 'DILIP SHANGHVI Executive Chairman',
    profileUrl: 'https://www.linkedin.com/company/sun-pharma/'
  }, 'https://sunpharma.com/', 'SUN PHARMA');
  assert.equal(companyPage.profileUrl, '', 'a company page is never a person profile');

  const none = officialPageCandidate({
    name: 'DILIP SHANGHVI', role: 'Executive Chairman', section: 'Board of Directors',
    pageTitle: 'Board of Directors | Sun Pharmaceutical Industries Limited',
    url: 'https://sunpharma.com/board-of-directors', evidence: 'DILIP SHANGHVI Executive Chairman'
  }, 'https://sunpharma.com/', 'SUN PHARMA');
  assert.equal(none.profileUrl, '');
});

T('a company-page profile link reaches the CSV LINKEDIN_URL cell', () => {
  const v = officialPageCandidate({
    name: 'Asha Shah', role: 'Chief Technology Officer', section: 'Leadership',
    pageTitle: 'Leadership | Acme Corp', url: 'https://example.com/leadership',
    evidence: 'Asha Shah Chief Technology Officer',
    profileUrl: 'https://www.linkedin.com/in/asha-shah/'
  }, 'https://example.com/', 'Acme Corp');
  assert.ok(v && v.profileUrl);
  const csv = buildCSV([{
    name: 'Acme Corp', website: 'https://example.com',
    people: [{ ...v, url: v.profileUrl, urlVerified: false, currentEmployer: 'official' }]
  }]);
  const cells = csv.trim().split('\r\n')[1].split(',');
  assert.equal(cells[cells.length - 1], 'https://www.linkedin.com/in/asha-shah/');
  assert.equal(cells[0], 'Asha');
});

T('resolveTargets: only people with no URL, capped and de-duplicated', () => {
  const people = [
    { name: 'Asha Shah', url: 'https://www.linkedin.com/in/asha-shah/' },
    { name: 'Ravi Menon', url: '' },
    { name: 'ravi menon', url: '' },
    { name: 'Priya Kumar' },
    { name: '', url: '' },
    { name: 'Sam Lee', url: '' },
    { name: 'Nina Rao', url: '' }
  ];
  const out = resolveTargets(people, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(p => p.name), ['Ravi Menon', 'Priya Kumar', 'Sam Lee']);
  assert.equal(resolveTargets(people, 0).length, 0);
  assert.equal(resolveTargets(people, 99).length, 4, 'capped at ten, and one duplicate name');
});

T('companyFactsFromPage: size, industry, HQ, country and LinkedIn URL', () => {
  const red = companyFactsFromPage({
    title: 'Redington Board of Directors | Leadership & Governance',
    description: 'Redington Group is a global IT services and technology solution provider.',
    text: 'Redington Group has over 5,000 employees. Registered office: Chennai, India.',
    linkedinUrl: 'https://www.linkedin.com/company/redington/?trk=footer'
  });
  assert.equal(red.employees, '5,000+ employees');
  assert.equal(red.industry, 'IT Services');
  assert.equal(red.hq, 'Chennai, India');
  assert.equal(red.country, 'India');
  assert.equal(red.linkedinUrl, 'https://www.linkedin.com/company/redington/');
  const lup = companyFactsFromPage({
    title: 'Our Leadership Team | Lupin Global Pharmaceuticals',
    text: 'Lupin has over 20,000 employees worldwide.',
    structured: {
      numberOfEmployees: { value: 20000, maxValue: 50000 },
      industry: 'Pharmaceuticals',
      address: { addressLocality: 'Mumbai', addressRegion: 'Maharashtra', addressCountry: 'IN' },
      sameAs: ['https://www.linkedin.com/company/lupin/']
    }
  });
  assert.equal(lup.employees, '20,000–50,000 employees');
  assert.equal(lup.industry, 'Pharmaceuticals');
  assert.equal(lup.hq, 'Mumbai, Maharashtra, India');
  assert.equal(lup.linkedinUrl, 'https://www.linkedin.com/company/lupin/');
  assert.equal(companyFactsFromPage({ text: 'Welspun has 40000+ employees.' }).employees, '40,000+ employees');
  // Never invent a "+" the source did not print.
  assert.equal(companyFactsFromPage({ text: 'The company employs 500 employees.' }).employees, '500 employees');
  assert.equal(companyFactsFromPage({ text: 'About 1,200 people work here.' }).employees, '1,200 employees');
  assert.equal(companyFactsFromPage({ text: 'A renewable energy company.' }).industry, 'Renewable Energy');
  const timeline = companyFactsFromPage({ text: 'Registered office: Chennai 2021 The acquisition of Brightstar in Turkey' });
  assert.ok(!/acquisition/i.test(timeline.hq));
  // A prose address is cut at the country it names, never left as a street fragment.
  const prose = companyFactsFromPage({ text: 'Registered office: Lupin Limited, 3rd Floor, Kalpataru Inspire, Off Western Express Highway, Mumbai 400055, India.' });
  assert.ok(/India$/.test(prose.hq), 'hq should end with the named country: ' + prose.hq);
  assert.equal(prose.country, 'India');
  // A cut-off address loses its dangling preposition instead of reporting "Off".
  const cut = companyFactsFromPage({ text: 'Registered office: Lupin Limited, 3rd Floor, Kalpataru Inspire, Off' });
  assert.equal(cut.hq, 'Lupin Limited, 3rd Floor, Kalpataru Inspire');
  // A legal name after "Registered office:" is not an address.
  assert.equal(companyFactsFromPage({ text: 'Registered office: Sun Pharmaceutical Industries Ltd' }).hq, '');
});

T('officialPageCandidate: leadership yes, external board role and lookalike no', () => {
  const site = 'https://acme.example';
  const lead = officialPageCandidate({
    name: 'Asha Shah', role: 'Chief Technology Officer',
    section: 'Acme Leadership team', pageTitle: 'Acme Leadership Team | Acme',
    url: 'https://acme.example/leadership', evidence: 'Asha Shah Chief Technology Officer'
  }, site, 'Acme');
  assert.ok(lead);
  assert.equal(lead.evidenceUrl, 'https://acme.example/leadership');
  assert.equal(lead.sourceType, 'official');
  assert.equal(officialPageCandidate({
    name: 'Charlie Bell', role: 'Executive Vice President, Engineer, Microsoft',
    section: 'Acme Board of Directors', pageTitle: 'Acme Leadership Team | Acme',
    url: 'https://acme.example/leadership', evidence: ''
  }, site, 'Acme'), null);
  assert.equal(officialPageCandidate({
    name: 'Asha Shah', role: 'Former Chief Technology Officer',
    section: 'Acme Leadership team', pageTitle: 'Acme Leadership',
    url: 'https://acme.example/leadership', evidence: ''
  }, site, 'Acme'), null);
  assert.equal(officialPageCandidate({
    name: 'Asha Shah', role: 'Chief Technology Officer',
    section: 'Acme Leadership team', pageTitle: 'Acme Leadership',
    url: 'https://acme.example.evil.com/leadership', evidence: ''
  }, site, 'Acme'), null);
  assert.equal(officialPageCandidate({
    name: 'Acme Corp', role: 'Chief Executive Officer',
    section: 'Acme Leadership team', pageTitle: 'Acme Leadership',
    url: 'https://acme.example/leadership', evidence: ''
  }, site, 'Acme'), null);
});

T('classifyOutcome: blocked, error, no profiles, rejected and found are distinct', () => {
  const base = {
    queryCount: 2, rawResultCount: 10, profileResultCount: 3, acceptedCount: 0,
    rejected: { wrong_company: 3 }, sourceStates: {}, queries: ['q1']
  };
  assert.equal(classifyOutcome(1, base).outcome, 'people_found');
  assert.equal(classifyOutcome(0, { ...base, sourceStates: { 'bing-captcha': 1 } }).outcome, 'search_blocked');
  assert.equal(classifyOutcome(0, { ...base, sourceStates: { 'bing-extractor-error': 1 } }).outcome, 'search_error');
  assert.equal(classifyOutcome(0, { ...base, profileResultCount: 0, official: { used: true, blocked: 1 } }).outcome, 'source_blocked');
  assert.equal(classifyOutcome(0, { ...base, profileResultCount: 0, official: { used: true, pages: 2, errors: 2 } }).outcome, 'source_error');
  assert.equal(classifyOutcome(0, { ...base, profileResultCount: 0, official: { used: true, pages: 3, candidates: 2 } }).outcome, 'no_profile_results');
  assert.equal(classifyOutcome(0, { ...base, acceptedCount: 0 }).outcome, 'candidates_rejected');
  assert.equal(classifyOutcome(0, { ...base, acceptedCount: 1 }).outcome, 'no_public_match');
  assert.match(classifyOutcome(0, base).detail, /last query: q1/);
});

T('extractOfficialLeadership: heading pairs and section boundaries', () => {
  const el = (tagName, innerText, extra) => Object.assign({ tagName, innerText, nextElementSibling: null, parentElement: null }, extra || {});
  const ceoName = el('H3', 'Khozema Shipchandler');
  const ceoRole = el('H4', 'Chief Executive Officer');
  const extName = el('H3', 'Charlie Bell');
  const extRole = el('H4', 'Executive Vice President, Engineer, Microsoft');
  ceoName.parentElement = { innerText: 'Khozema Shipchandler Chief Executive Officer' };
  extName.parentElement = { innerText: 'Charlie Bell Executive Vice President, Engineer, Microsoft' };
  const heads = [
    el('H1', 'Meet our team'), el('H2', 'Acme Leadership team'), ceoName, ceoRole,
    el('H2', 'Acme Board of Directors'), extName, extRole
  ];
  const fakeDocument = {
    title: 'Acme Leadership Team & Board of Directors | Acme',
    body: { innerText: 'Acme leadership team' },
    querySelectorAll(selector) {
      if (selector === 'h1,h2,h3,h4,h5') return heads;
      if (selector === 'script[type="application/ld+json"]') return [];
      if (selector === 'a[href]') return [{
        href: 'https://acme.example/leadership', innerText: 'Leadership', getAttribute() { return ''; }
      }];
      return [];
    }
  };
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const oldLocation = globalThis.location;
  globalThis.document = fakeDocument;
  globalThis.location = { href: 'https://acme.example/leadership', hostname: 'acme.example' };
  try {
    const out = extractOfficialLeadership();
    assert.equal(out.blocked, false);
    assert.equal(out.candidates.length, 2);
    assert.equal(out.candidates[0].name, 'Khozema Shipchandler');
    assert.equal(out.candidates[0].section, 'Acme Leadership team');
    assert.equal(out.candidates[1].section, 'Acme Board of Directors');
    assert.ok(out.links.some(link => /leadership/.test(link.url)));
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
    if (hadLocation) globalThis.location = oldLocation; else delete globalThis.location;
  }
});

T('extractLinkedInCompany: Cloudflare challenge is not a company', () => {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  globalThis.document = {
    title: 'Just a moment...',
    body: { innerText: 'Performing security verification' },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  try {
    const out = extractLinkedInCompany();
    assert.equal(out.found, false);
    assert.equal(out.authwall, true);
    assert.equal(out.blocked, true);
    assert.equal(out.name, '');
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
  }
});

T('extractLinkedInCompany: Join LinkedIn authwall is not a company', () => {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  globalThis.document = {
    title: 'Join LinkedIn',
    body: { innerText: 'Join LinkedIn to see who you know' },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  try {
    const out = extractLinkedInCompany();
    assert.equal(out.found, false);
    assert.equal(out.authwall, true);
    assert.equal(out.name, '');
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
  }
});

T('extractBingResults: redirect/direct duplicates and non-person paths', () => {
  const profile = 'https://www.linkedin.com/in/asha/';
  const anchors = [
    { href: profile + '?trk=public_profile', innerText: 'Asha Shah - CTO - Acme | LinkedIn', closest() { return null; }, parentElement: null },
    { href: profile, innerText: 'Asha Shah - CTO - Acme | LinkedIn', closest() { return null; }, parentElement: null },
    { href: 'https://www.linkedin.com/in/dir/people/', innerText: 'Directory', closest() { return null; }, parentElement: null },
    { href: 'https://www.linkedin.com/in/groups/x/', innerText: 'Group', closest() { return null; }, parentElement: null },
    { href: 'https://www.linkedin.com/in/topic/x/', innerText: 'Topic', closest() { return null; }, parentElement: null }
  ];
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const oldLocation = globalThis.location;
  globalThis.document = {
    title: 'Bing results',
    body: { innerText: 'Search results', innerHTML: '' },
    querySelector(selector) { return selector === '#b_results' ? {} : null; },
    querySelectorAll(selector) {
      if (selector === '#b_results li.b_algo') return [];
      if (selector === 'a[href]') return anchors;
      return [];
    }
  };
  globalThis.location = { href: 'https://www.bing.com/search?q=acme' };
  try {
    const out = extractBingResults();
    assert.equal(out.profileResultCount, 1);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, profile);
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
    if (hadLocation) globalThis.location = oldLocation; else delete globalThis.location;
  }
});

T('extractBingResults: consent, captcha and no-results are distinct', () => {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const oldDocument = globalThis.document;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const oldLocation = globalThis.location;
  const fake = (title, bodyText, html, hasResults) => ({
    title,
    body: { innerText: bodyText, innerHTML: html || '' },
    querySelector(selector) {
      if (selector === '#b_results') return hasResults ? {} : null;
      if (selector === 'form[action*="/search"]') return null;
      return null;
    },
    querySelectorAll() { return []; }
  });
  globalThis.location = { href: 'https://www.bing.com/search?q=x' };
  try {
    globalThis.document = fake('Before you continue to Bing', 'Before you continue to Bing', '', false);
    assert.equal(extractBingResults().consent, true);
    globalThis.document = fake('Verify you are human', 'Please verify you are human', '', false);
    assert.equal(extractBingResults().captcha, true);
    globalThis.document = fake('Search', 'No results', '<div class="b_no">There are no results for x</div>', true);
    assert.equal(extractBingResults().noResults, true);
  } finally {
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
    if (hadLocation) globalThis.location = oldLocation; else delete globalThis.location;
  }
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

T('cell prevents spreadsheet formula injection', () => {
  assert.equal(cell('=HYPERLINK("https://bad.example")'), '=HYPERLINK("https://bad.example")');
  assert.equal(exportCell('=HYPERLINK("https://bad.example")'), "'=HYPERLINK(\"https://bad.example\")");
  assert.equal(exportCell('+SUM(1,1)'), "'+SUM(1,1)");
  assert.equal(exportCell('Plain text'), 'Plain text');
});

T('splitProspectName: keeps global name tokens without guessing', () => {
  assert.deepEqual(splitProspectName('Jane Doe'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitProspectName('Ana María de la Cruz'), { firstName: 'Ana', lastName: 'María de la Cruz' });
  assert.deepEqual(splitProspectName('Dr. Jean-Claude Van Damme'), { firstName: 'Jean-Claude', lastName: 'Van Damme' });
  assert.deepEqual(splitProspectName('Dr. Jane Doe, PhD'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitProspectName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitProspectName('Doe, Jane'), { firstName: '', lastName: '' });
  assert.deepEqual(splitProspectName(null), { firstName: '', lastName: '' });
});

T('buildCSV: default is the exact 10-column CRM contract, and nothing else', () => {
  const comps = [{
    name: 'Acme Corp', country: 'India', size: '201-500 employees',
    industry: 'Software Development', website: 'https://www.acme.example/about',
    url: 'https://www.linkedin.com/company/acme/',
    people: [
      { name: 'Jane Doe', designation: 'Chief Technology Officer', url: 'https://www.linkedin.com/in/jane/', urlVerified: true, currentEmployer: 'current', pri: 1, score: 110, priority: 'P1', email: 'jane.doe@acme.io', emailStatus: 'estimated — unverified' },
      { name: 'Bob Lee', designation: 'Head of Product', url: '', urlVerified: false, pri: 2, score: 90, priority: 'P2' }
    ]
  }, {
    name: 'Empty Co', people: [], url: ''
  }];
  const csv = buildCSV(comps);
  const lines = csv.replace(/\r\n$/, '').split('\r\n');
  assert.deepEqual(CRM_EXPORT_HEADERS, CRM_EXPORT_CONTRACT);
  assert.deepEqual(lines[0].split(','), CRM_EXPORT_CONTRACT);
  assert.equal(lines.length, 3); // header + accepted people; no fake review prospect
  const jane = lines[1].split(',');
  assert.deepEqual(jane, [
    'Jane', 'Doe', 'Chief Technology Officer', 'jane.doe@acme.io', 'Acme Corp',
    '201-500 employees', 'India', 'Software Development', 'acme.example',
    'https://www.linkedin.com/in/jane/'
  ]);
  const bob = lines[2].split(',');
  assert.equal(bob[0], 'Bob');
  assert.equal(bob[1], 'Lee');
  assert.equal(bob[3], '');
  assert.equal(bob[9], '');
});

T('CSV format: RFC 4180 round-trip, no column shift', () => {
  // Minimal RFC 4180 reader — the point is to prove Excel would parse the same
  // fields we intended, including commas, quotes and Unicode inside a value.
  const parse = (text) => {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r') { /* ignore */ }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };

  const comps = [{
    name: 'Godrej, Industries "Group"', website: 'https://www.godrejindustries.com',
    size: '10,001+ employees', country: 'India', industry: 'Holding Companies',
    hq: 'Mumbai, Maharashtra, India', url: 'https://www.linkedin.com/company/godrej-industries/',
    people: [
      { name: 'Aasif Malbari', designation: 'Managing Director & CEO, Godrej Consumer Products', email: 'aasif@x.com', emailStatus: 'estimated — unverified', url: 'https://in.linkedin.com/in/Aasif-Malbari/?trk=x', currentEmployer: 'current', priority: 'P1', verification: 'Verified LinkedIn profile', evidenceUrl: 'https://godrejindustries.com/leadership', sourceType: 'linkedin', linkedinSource: 'search' },
      { name: 'José García', designation: 'Head of AI, Europe', email: '', currentEmployer: 'official', priority: 'P2', sourceType: 'official', evidenceUrl: 'https://x.com/team' }
    ]
  }];

  const rows = parse(buildCSV(comps));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], CRM_EXPORT_HEADERS);
  for (const r of rows.slice(1)) assert.equal(r.length, 10, 'every row has exactly ten cells');
  assert.equal(rows[1][2], 'Managing Director & CEO, Godrej Consumer Products', 'comma stays inside DESIGNATION');
  assert.equal(rows[1][4], 'Godrej, Industries "Group"', 'quotes survive');
  assert.equal(rows[1][5], '10,001+ employees');
  assert.equal(rows[1][9], 'https://www.linkedin.com/in/aasif-malbari/', 'canonical profile, tracking removed');
  assert.equal(rows[2][0], 'José');
  assert.equal(rows[2][3], '', 'blank email stays blank');
});

T('Full CSV carries every field in its own column', () => {
  const comps = [{
    name: 'Acme Corp', website: 'https://www.acme.com', size: '201-500', country: 'India',
    industry: 'Software', hq: 'Pune, India', url: 'https://www.linkedin.com/company/acme/',
    people: [{
      name: 'Asha Shah', designation: 'CTO', email: 'asha@acme.io', emailStatus: 'estimated — unverified',
      url: 'https://www.linkedin.com/in/asha-shah/', urlVerified: false, currentEmployer: 'official',
      priority: 'P1', verification: 'Official company source',
      evidenceUrl: 'https://acme.com/team', sourceType: 'official'
    }]
  }];
  const header = buildCSV(comps, { full: true }).split('\r\n')[0];
  assert.equal(header, FULL_EXPORT_HEADERS.join(','));
  assert.equal(FULL_EXPORT_HEADERS.length, 19);
  const row = buildCSV(comps, { full: true }).split('\r\n')[1];
  assert.ok(row.startsWith('Asha,Shah,CTO,asha@acme.io,Acme Corp,201-500,India,Software,acme.com,https://www.linkedin.com/in/asha-shah/,'));
  assert.ok(row.includes('"Pune, India"'), 'HQ with a comma stays one quoted cell');
  assert.ok(row.includes('https://www.linkedin.com/company/acme/'));
  assert.ok(row.includes('Current (official company source)'));
  assert.ok(row.endsWith(',Official company source'), 'source is the last column');
});

T('TSV is the same table with tabs, for pasting into Excel', () => {
  const comps = [{
    name: 'Acme, Inc', people: [{
      name: 'Asha Shah', designation: 'Head\tof Sales', currentEmployer: 'current'
    }]
  }];
  const lines = buildTSV(comps).replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines[0], CRM_EXPORT_HEADERS.join('\t'));
  const cells = lines[1].split('\t');
  assert.equal(cells.length, 10);
  assert.equal(cells[2], 'Head of Sales', 'an embedded tab cannot add a column');
  assert.equal(cells[4], 'Acme, Inc', 'commas are safe in TSV');
});

T('buildCSV: no manufactured row for a review-only company', () => {
  const csv = buildCSV([{ name: 'Empty Co', people: [], reviewReason: 'Needs manual review' }]);
  assert.deepEqual(csv.replace(/\r\n$/, '').split('\r\n'), [CRM_EXPORT_CONTRACT.join(',')]);
});

T('buildCSV: quotes commas properly', () => {
  const comps = [{
    name: 'Acme, Inc.', country: '', size: '', industry: '', url: '',
    people: [{ name: 'A B', designation: 'CTO', url: '', urlVerified: false, pri: 1, score: 1, priority: 'P1' }]
  }];
  const csv = buildCSV(comps);
  assert.deepEqual(csv.replace(/\r\n$/, '').split('\r\n')[0].split(','), CRM_EXPORT_CONTRACT);
  assert.ok(csv.includes('"Acme, Inc."'));
});

T('buildCSV applies spreadsheet formula protection at export time', () => {
  const csv = buildCSV([{
    name: '=Danger Co', people: [{
      name: '+Formula Person', designation: 'CTO', url: '', urlVerified: false,
      pri: 1, score: 1, priority: 'P1'
    }]
  }]);
  const row = csv.replace(/\r\n$/, '').split('\r\n')[1].split(',');
  assert.equal(row[0], "'+Formula");
  assert.equal(row[1], 'Person');
  assert.equal(row[4], "'=Danger Co");
});

T('buildCSV: official-source row keeps evidence out of the LinkedIn cell', () => {
  const comps = [{
    name: 'Acme Corp', website: 'https://acme.example', url: 'https://www.linkedin.com/company/acme/', people: [{
      name: 'Asha Shah', designation: 'Chief Technology Officer', url: '',
      evidenceUrl: 'https://acme.example/leadership', sourceType: 'official',
      verification: 'Official company source', currentEmployer: 'official',
      pri: 1, score: 100, priority: 'P1'
    }]
  }];
  const csv = buildCSV(comps);
  const row = csv.replace(/\r\n$/, '').split('\r\n')[1].split(',');
  assert.equal(row[8], 'acme.example');
  assert.equal(row[9], '');
  assert.equal(csv.includes('https://acme.example/leadership'), false);
});

T('buildCSV: LinkedIn field rejects a company page', () => {
  const csv = buildCSV([{
    name: 'Acme Corp', people: [{
      name: 'Jane Doe', designation: 'CTO',
      url: 'https://www.linkedin.com/company/acme/'
    }]
  }]);
  assert.equal(csv.replace(/\r\n$/, '').split('\r\n')[1].split(',')[9], '');
});

T('buildCSV: a possibly-past role never becomes an exported row', () => {
  const comp = {
    name: 'Acme Corp',
    people: [
      { name: 'Jane Doe', designation: 'CEO', url: '', currentEmployer: 'current' },
      { name: 'Old Hand', designation: 'CEO', url: '', currentEmployer: 'review-past' }
    ]
  };
  const lines = buildCSV([comp]).replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines.length, 2, 'only the accepted current person is exported');
  assert.equal(lines[1].split(',')[0], 'Jane');
});

T('buildCSV: strips tracking params and rejects a bare /in/', () => {
  const rows = buildCSV([{
    name: 'Acme Corp',
    people: [
      { name: 'Jane Doe', designation: 'CTO', url: 'https://www.linkedin.com/in/jane-doe/?trk=profile' },
      { name: 'Bare Link', designation: 'CIO', url: 'https://www.linkedin.com/in/' }
    ]
  }]).replace(/\r\n$/, '').split('\r\n');
  assert.equal(rows[1].split(',')[9], 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(rows[2].split(',')[9], '');
});

T('buildCSV: one row model, so tabs and newlines cannot shift columns', () => {
  const comps = [{
    name: 'Tab Co',
    website: '',
    people: [{ name: 'A B', designation: 'Head\tof\nSales', currentEmployer: 'current' }]
  }];
  const csv = buildCSV(comps);
  assert.ok(csv.includes('Head of Sales'));
  const csvRows = csv.replace(/\r\n$/, '').split('\r\n');
  assert.equal(csvRows.length, 2);
  assert.equal(csvRows[1].split(',').length, CRM_EXPORT_HEADERS.length);
});

T('buildCSV: Unicode, quoting and formula safety', () => {
  const csv = buildCSV([{
    name: 'Acme, Inc.', people: [{
      name: 'José García', designation: 'CTO', url: '', urlVerified: false,
      pri: 1, score: 1, priority: 'P1', email: '=SUM(1,1)', emailStatus: 'estimated — unverified'
    }]
  }]);
  assert.ok(csv.includes('"Acme, Inc."'));
  assert.ok(csv.includes('José,García'));
  assert.ok(csv.includes("'=SUM(1,1)"));
  assert.equal(csv.includes('estimated — unverified'), false);
});

T('filtered UI exports retain WEBSITE_NAME in popup and full results', () => {
  const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
  const results = fs.readFileSync(new URL('../results.js', import.meta.url), 'utf8');
  assert.match(popup, /website:\s*r\.comp\.website/);
  assert.match(results, /website:\s*r\.comp\.website/);
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

// ---- MV3 background smoke -------------------------------------------------
// Runs the real module against a deliberately tiny Chrome API double. This
// catches service-worker boot errors that pure-module imports cannot reach.
await (async function backgroundSmoke() {
  const name = 'MV3 background smoke: boot, alarm compatibility, ping';
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome');
  const oldChrome = globalThis.chrome;
  let messageHandler = null;
  let alarm = null;
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { create: async () => {} },
    tabs: {
      onActivated: { addListener: () => {} },
      get: async () => { throw new Error('not used by smoke'); },
      create: async () => ({ id: 1 }), update: async () => {}, remove: async () => {}
    },
    scripting: { executeScript: async () => [] },
    alarms: {
      create: (name, info) => { alarm = { name, ...info }; },
      onAlarm: { addListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      onInstalled: { addListener: () => {} },
      getManifest: () => ({ version: '1.8.0' }),
      getPlatformInfo: () => {}
    }
  };
  try {
    const url = new URL('../background.js?smoke=' + Date.now(), import.meta.url).href;
    await import(url);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(alarm && alarm.periodInMinutes, 1);
    assert.equal(typeof messageHandler, 'function');
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ping did not respond')), 1000);
      const keepAlive = messageHandler({ type: 'ping' }, {}, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      assert.equal(keepAlive, true);
    });
    assert.deepEqual(response, { ok: true, version: '1.8.0' });
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '  → ' + e.message);
  } finally {
    if (hadChrome) globalThis.chrome = oldChrome; else delete globalThis.chrome;
  }
})();


// ---- v2.2 workspace records (side panel + capture) ----

T('records: normalize keeps unknown fields blank and cleans URLs', () => {
  const r = normalizeRecord({
    name: 'Dr. Asha Shah', email: ' ASHA@Acme.IO ',
    website: 'https://www.acme.com/about?x=1',
    linkedinUrl: 'https://www.linkedin.com/in/asha-shah/?trk=abc'
  });
  assert.equal(r.firstName, 'Asha');
  assert.equal(r.lastName, 'Shah');
  assert.equal(r.email, 'asha@acme.io');
  assert.equal(r.website, 'acme.com');
  assert.equal(r.linkedinUrl, 'https://www.linkedin.com/in/asha-shah/');
  assert.equal(r.company, '', 'no company is invented');
  assert.deepEqual(recordRow(r).length, 10);
  assert.deepEqual(Object.keys(emptyRecord()).slice(0, 10), RECORD_FIELDS);
});

T('records: dedupe by profile URL fills blanks but never overwrites', () => {
  const out = mergeRecords(
    [{ firstName: 'Asha', lastName: 'Shah', company: 'Acme Corp', linkedinUrl: 'https://www.linkedin.com/in/asha-shah/' }],
    [{ firstName: 'Asha', lastName: 'Shah', company: 'Wrong Co', country: 'India', linkedinUrl: 'https://www.linkedin.com/in/asha-shah/?trk=x' }]
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].company, 'Acme Corp');
  assert.equal(out.rows[0].country, 'India');
  assert.equal(out.updated, 1);
  assert.equal(out.added, 0);
});

T('records: dedupe by email+name, blank rows ignored', () => {
  const out = mergeRecords(
    [{ firstName: 'Luca', lastName: 'de Vries', email: 'luca@orbit.io' }],
    [
      { firstName: 'Luca', lastName: 'de Vries', email: 'luca@orbit.io', company: 'Orbit Labs' },
      emptyRecord(),
      { firstName: '', lastName: '', company: 'Ghost Co' }
    ]
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].company, 'Orbit Labs');
  assert.equal(recordKey(emptyRecord()), '', 'a blank row has no identity');
});

T('records: CSV is exactly ten values with quoting, Unicode and formula safety', () => {
  const csv = recordsToCSV([
    { firstName: 'José', lastName: 'García', company: 'Acme, Inc.', email: '=SUM(1,1)', designation: 'CTO' },
    { firstName: 'A', lastName: 'B', website: 'acme.com', linkedinUrl: 'https://www.linkedin.com/in/ab/' }
  ]);
  const lines = csv.replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines[0], CRM_EXPORT_HEADERS.join(','));
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('"Acme, Inc."'));
  assert.ok(lines[1].includes('José,García'));
  assert.ok(lines[1].includes("'=sum(1,1)"), 'formula-looking values stay text (email is lowercased)');
});

T('records: TSV collapses tabs and newlines so the grid cannot shift', () => {
  const tsv = recordsToTSV([{ firstName: 'A', lastName: 'B', designation: 'Head\tof\nSales', company: 'Acme' }]);
  const lines = tsv.split('\n');
  assert.equal(lines[0], CRM_EXPORT_HEADERS.join('\t'));
  const cells = lines[1].split('\t');
  assert.equal(cells.length, 10);
  assert.equal(cells[2], 'Head of Sales');
});

T('LinkedIn URLs are canonical: one profile has one identity', () => {
  const variants = [
    'https://in.linkedin.com/in/Asha-Shah/?trk=x',
    'https://www.linkedin.com/in/asha-shah',
    'https://linkedin.com/in/asha-shah/'
  ];
  for (const v of variants) {
    assert.equal(linkedinUrlForExport(v), 'https://www.linkedin.com/in/asha-shah/');
  }
  assert.equal(linkedinUrlForExport('https://www.linkedin.com/company/acme/'), '');
  const a = mergeRecords([{ firstName: 'Asha', lastName: 'Shah', linkedinUrl: variants[0] }], []);
  const b = mergeRecords(a.rows, [{ firstName: 'Asha', lastName: 'Shah', linkedinUrl: variants[1], company: 'Acme Corp' }]);
  assert.equal(b.rows.length, 1, 'in./www. variants are the same person');
  assert.equal(b.rows[0].company, 'Acme Corp');
});

T('records: resolver query and verification link are honest', () => {
  const rec = { firstName: 'Asha', lastName: 'Shah', company: 'Acme Corp' };
  // Measured on Bing: a second quoted phrase returns zero results, so the
  // name-only query must come first.
  assert.equal(linkedinSearchQuery(rec), 'site:linkedin.com/in "Asha Shah"');
  assert.deepEqual(linkedinSearchQueries(rec), [
    'site:linkedin.com/in "Asha Shah"',
    'site:linkedin.com/in "Asha Shah" Acme Corp'
  ]);
  assert.equal(linkedinSearchQuery({ firstName: 'Asha', lastName: 'Shah', designation: 'CTO' }),
    'site:linkedin.com/in "Asha Shah"');
  assert.equal(linkedinSearchQuery({ firstName: '', lastName: '' }), '');
  assert.match(verifySearchUrl(rec), /^https:\/\/www\.google\.com\/search\?q=/);
  // A profile is accepted only when the result names the person and the company.
  const good = [{ url: 'https://in.linkedin.com/in/asha-shah/', title: 'Asha Shah - CTO - Acme Corp | LinkedIn' }];
  assert.equal(pickProfileResult(good, rec), 'https://www.linkedin.com/in/asha-shah/');
  const sameName = [{ url: 'https://www.linkedin.com/in/asha-shah-2/', title: 'Asha Shah - Designer | LinkedIn' }];
  assert.equal(pickProfileResult(sameName, rec), '', 'a same-name stranger is not a match');
  const companyPage = [{ url: 'https://www.linkedin.com/company/acme/', title: 'Acme Corp | LinkedIn' }];
  assert.equal(pickProfileResult(companyPage, rec), '');
  assert.equal(companyToken('Godrej Industries Group'), 'godrej');
  assert.equal(needsResolution(rec), true);
  assert.equal(needsResolution({ linkedinUrl: 'https://www.linkedin.com/in/xavier-doe/' }), false);
});

T('records: selection parsing handles separators and drops noise', () => {
  const rows = parseSelectionText([
    'Asha Shah — CTO at Acme Corp',
    'Luca de Vries | VP Product | Orbit Labs',
    'Priya Kumar, Head of AI, Nova Systems',
    'Read more about our team',
    'Contact us'
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].firstName, 'Asha');
  assert.equal(rows[0].designation, 'CTO');
  assert.equal(rows[0].company, 'Acme Corp');
  assert.equal(rows[1].lastName, 'de Vries');
  assert.equal(rows[2].company, 'Nova Systems');
});

T('workspace: side panel headers match the CRM contract in order', () => {
  const html = fs.readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
  const ths = [...html.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(v => /^[A-Z_]+$/.test(v) && v.length > 3);
  assert.deepEqual(ths, CRM_EXPORT_HEADERS);
  assert.equal(ths.length, 10);
});

T('workspace: manifest declares the side panel, capture menu and permissions', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  for (const p of ['sidePanel', 'contextMenus', 'activeTab', 'storage', 'scripting']) {
    assert.ok(m.permissions.includes(p), 'missing permission ' + p);
  }
  assert.ok(!m.permissions.includes('tabs') === false);
  assert.equal(m.optional_host_permissions.length, 1);
});

// ---- v1.4.1 ESM link check (reproduces Chrome "status code: 15") ----
// Plain node --check is parse-only and cannot see import-binding conflicts
// (e.g. a local function shadowing an imported name). Importing the entry
// files with the real module loader does. Anything other than hitting a
// browser-only global (chrome/document/…) is fatal.
const BENIGN_RE = /\b(chrome|document|window|localStorage|navigator|location|URL|fetch|AbortController|crypto)\s+is not defined\b/i;
const ENTRIES = ['../background.js', '../popup.js', '../results.js', '../sidepanel.js'];

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
