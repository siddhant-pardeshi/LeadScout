// LeadScout — background orchestrator (MV3 service worker, ES module).
//
// Pipeline per company (each company is researched in FULL isolation — this is
// what prevents the "bulk paste gives wrong details" problem):
//   1. resolve company slug (Bing)            [only for plain names]
//   2. read the LinkedIn company page         [deepScan, verified facts]
//   3. run scoped Bing queries for profiles   [site:linkedin.com/in "Company"]
//   4. optional AI enrichment (Groq/Gemini)   [corpus-restricted, no invention]
//   5. rank, dedupe, flag verification, estimate emails
//
// All browsing happens in real hidden tabs with the user's own session, with
// human-like pacing; captcha walls pause the queue for manual handling.

import { DEFAULT_SETTINGS, PROVIDERS } from './lib/parse.js';
import { normalizeKeyMeta } from './lib/keys.js';
import {
  slugFromUrl, titleCaseSlug, decodeBingUrl, parseProfileTitle, linkedinHandle,
  isLinkedInProfile, companyMatch, companyMatchPartial, emailFor, domainFromWebsite,
  extractSizeFromText, overlapTokens, kebabName, slugScore, looseResolveMatch,
  roleCurrency, matchHunterEmail, cell, nameEvidence, officialLeadershipCandidate,
  inferWebsiteFromSerp, officialPageCandidate, classifyOutcome, domainMatchesCompany, websiteCandidates,
  companyFactsFromPage
} from './lib/parse.js';
import { classifyDesignation, seniorityBonus } from './lib/rank.js';
import { aiResearch, aiTestKey } from './lib/ai.js';
import { hunterDomainSearch } from './lib/hunter.js';
import { extractBingResults, extractLinkedInCompany, extractOfficialLeadership } from './lib/extract.js';
import { extractPageLeads } from './content.js';
import { normalizeRecord, linkedinSearchQuery } from './lib/records.js';

// ------------------------------------------------------------ app state ----

let SETTINGS = { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } };
const S = {
  job: {
    running: false, paused: false, cursor: 0, queue: [], results: [],
    startedAt: null, finishedAt: null, attention: null, perCompanyMs: 0, doneCount: 0
  },
  busy: false,
  runId: 0,
  tabBing: null,
  tabLI: null,
  tabOfficial: null,
  lastActiveTab: null,
  heartbeat: null
};

function persist() {
  S.job.updatedAt = Date.now();
  return chrome.storage.local.set({ job: S.job });
}
async function loadAll() {
  const st = await chrome.storage.local.get(['settings', 'job']);
  if (st.settings) SETTINGS = {
    ...DEFAULT_SETTINGS, ...st.settings,
    keys: { ...DEFAULT_SETTINGS.keys, ...(st.settings.keys || {}) },
    keyMeta: normalizeKeyMeta(st.settings.keyMeta)
  };
  if (st.job) S.job = { ...S.job, ...st.job };
}
async function saveSettings() {
  await chrome.storage.local.set({ settings: SETTINGS });
}

function setBadge() {
  try {
    if (S.job.running) {
      const remaining = Math.max(0, S.job.queue.length - S.job.cursor);
      chrome.action.setBadgeText({ text: String(remaining) });
      chrome.action.setBadgeBackgroundColor({ color: '#6D28D9' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* ignore */ }
}

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic', iconUrl: 'icons/icon48.png', title, message
    });
  } catch (e) { /* ignore */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Human-like pacing jitter (NOT cryptographic — timing only), still uses CSPRNG for cleanliness.
function jitter(base) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const factor = 0.75 + (arr[0] / 4294967296) * 0.6; // 0.75 – 1.35
  return Math.max(400, Math.round(base * factor));
}

// ------------------------------------------------------- worker-tab utils ----

async function ensureTab(which, url) {
  const key = which === 'bing' ? 'tabBing' : (which === 'official' ? 'tabOfficial' : 'tabLI');
  let tabId = S[key];
  const wants = url;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && !tab.id) throw new Error('no tab');
  } catch (e) {
    const created = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = created.id;
    S[key] = tabId;
  }
  await chrome.tabs.update(tabId, { url: wants });
  return tabId;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { throw new Error('Tab was closed'); }
    if (tab.status === 'complete') { await sleep(450); return; } // settle for late-rendered DOM
    await sleep(300);
  }
  // timeout — proceed anyway; the extractor will tell us what it sees
}

// ----------------------------------------------- injected page extractors ----
// Defined in lib/extract.js and imported above — the SAME functions are used
// by the popup for "Add current page", so behaviour is identical everywhere.

// ------------------------------------------------------------ search I/O ----

async function bingSearch(query) {
  const host = SETTINGS.searchHost || 'www.bing.com';
  const url = 'https://' + host + '/search?q=' + encodeURIComponent(query) + '&count=30';
  const tabId = await ensureTab('bing', url);
  await waitForTabLoad(tabId, 22000);
  const meta = {
    query: query, state: 'ok', attempts: 0, resultCount: 0,
    profileResultCount: 0, standardResultCount: 0
  };
  let res = null;
  let extractionErrors = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    meta.attempts = attempt + 1;
    try {
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractBingResults });
      res = frames && frames[0] && frames[0].result;
    } catch (e) {
      extractionErrors++;
      await sleep(1200);
      continue;
    }
    if (res && res.captcha) break;
    if (res && res.consent && attempt < 2) {
      await sleep(2600);   // first-run/region redirect — give it a beat, re-read
      continue;
    }
    if (res && res.results && res.results.length) break;
    await sleep(1400); // late render — try once more
  }
  if (!res) {
    const err = new Error('Bing result extraction failed after ' + extractionErrors + ' attempts');
    err.code = 'bing-extractor-error';
    throw err;
  }
  if (res.captcha) {
    meta.state = 'captcha';
    S.job.paused = true;
    S.job.attention = 'Bing is asking for human verification. Open any Bing search tab, complete the check, then click Resume.';
    await persist();
    notify('ls-captcha', 'LeadScout paused', 'Bing needs human verification — complete it, then Resume in LeadScout.');
    const err = new Error('Bing captcha — queue paused');
    err.code = 'bing-captcha';
    throw err;
  }
  if (res.consent) {
    meta.state = 'consent';
    S.job.paused = true;
    S.job.attention = 'Bing needs consent before search results can load. Open the LeadScout Bing tab, complete the consent screen, then click Resume.';
    await persist();
    notify('ls-consent', 'LeadScout paused', 'Bing needs consent before LeadScout can search. Complete it in the Bing tab, then Resume.');
    const err = new Error('Bing consent required — queue paused');
    err.code = 'bing-consent';
    throw err;
  }
  const results = (res.results || []).map(r => ({ ...r, url: decodeBingUrl(r.url) }));
  meta.resultCount = results.length;
  meta.standardResultCount = Number(res.standardResultCount || 0);
  meta.profileResultCount = results.filter(r => isLinkedInProfile(r.url)).length;
  if (res.noResults) meta.state = 'no-results';
  else if (!results.length) meta.state = 'no-readable-results';
  // v1.4: skip the trailing pacing delay when the queue stopped (no wasted lag)
  if (S.job.running && !S.job.paused) {
    await sleep(jitter(SETTINGS.bingDelayMs || 2200));
  }
  return { results, meta };
}

async function readLinkedInCompany(slug) {
  // v1.1: the /about/ page carries ALL company facts (industry, size, HQ,
  // website) — the base page is heavily authwalled for guests and often omits
  // them. Try /about/ first, then the base page; re-extract to ride out
  // LinkedIn's late SPA rendering. Bail fast on hard authwalls.
  const urls = [
    'https://www.linkedin.com/company/' + slug + '/about/',
    'https://www.linkedin.com/company/' + slug + '/'
  ];
  let best = { found: false, authwall: false };
  for (const url of urls) {
    const tabId = await ensureTab('li', url);
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForTabLoad(tabId, 28000);
      await sleep(1400);
      let out = null;
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractLinkedInCompany });
        out = frames && frames[0] && frames[0].result;
      } catch (e) { out = null; }
      if (!out) { await sleep(1800); continue; }
      last = out;
      if (out.authwall) break;                                    // wall → try next URL form
      if (out.found && (out.industry || out.size || out.hq || out.website)) return out;
      if (out.found && attempt >= 1) break;                       // name at least; accept
      await sleep(1800);                                          // late render — re-extract
    }
    if (last && last.found) best = last;
    if (best.found && (best.industry || best.size || best.hq || best.website)) return best;
    // name-only or walled → fall through and try the other URL form
  }
  return best;
}

// ------------------------------------------------------------ query plans ----

function stripQuotes(s) { return String(s || '').replace(/[""]/g, ' ').trim(); }

function buildQueries(item) {
  const name = stripQuotes(item.name || titleCaseSlug(item.slug));
  const q = [];
  // (v1.2: the resolve query moved to researchCompany step 1 — no duplicate here)
  const mode = SETTINGS.scanMode || 'standard';
  const execQ = 'site:linkedin.com/in "' + name + '" ("CEO" OR "CTO" OR "CIO" OR "COO" OR "Founder" OR "Co-Founder" OR "President" OR "Chief" OR "Owner" OR "Managing Director")';
  const leadQ = 'site:linkedin.com/in "' + name + '" ("Head of" OR "VP" OR "Vice President" OR "Director") ("Product" OR "Engineering" OR "Technology" OR "Software")';
  const aiQ = 'site:linkedin.com/in "' + name + '" ("AI" OR "Machine Learning" OR "Generative AI" OR "Automation" OR "Data Science")';
  const digQ = 'site:linkedin.com/in "' + name + '" ("Digital Transformation" OR "Innovation" OR "IT Director" OR "CISO" OR "Architect" OR "R&D")';
  if (mode === 'quick') q.push(execQ);
  else if (mode === 'standard') { q.push(execQ, leadQ); }
  else { q.push(execQ, leadQ, aiQ, digQ); }
  return q;
}

function buildOfficialLeadershipQueries(website) {
  const domain = domainFromWebsite(website);
  if (!domain) return [];
  const seniorRoles = '"Chief Executive Officer" OR CEO OR CTO OR CIO OR "Managing Director" OR President OR Founder OR "Head of Engineering" OR "Head of Product"';
  return [
    'site:' + domain + ' (' + seniorRoles + ')',
    'site:' + domain + ' (leadership OR "executive team" OR management OR "our people")'
  ];
}

// ------------------------------------------------------ people assembly -----

function peopleFromSerp(serp, companyName, allowPartial) {
  const out = [];
  const seen = new Set();
  const stats = {
    resultCount: (serp || []).length, profileResultCount: 0, parseableCount: 0,
    acceptedCount: 0,
    rejected: {
      not_profile: 0, bad_profile_url: 0, directory_or_nonperson: 0,
      duplicate: 0, unparseable_title: 0, wrong_company: 0, past_role: 0
    }
  };
  // Strict all-token match by default (anti-bleed). When a plain company name
  // could NOT be resolved to a LinkedIn page, the typed legal name won't appear
  // on profiles ("at Zoho" vs "Zoho Corporation") — fall back to partial
  // token matching, still scoped to this company's own search results.
  const match = allowPartial
    ? (hay) => companyMatch(hay, companyName) || companyMatchPartial(hay, companyName)
    : (hay) => companyMatch(hay, companyName);
  for (const r of serp) {
    const url = r.url || '';
    if (!isLinkedInProfile(url)) { stats.rejected.not_profile++; continue; }
    stats.profileResultCount++;
    const handle = linkedinHandle(url);
    if (!handle) { stats.rejected.bad_profile_url++; continue; }
    const parsed = parseProfileTitle(r.title);
    // v1.4 precision: LinkedIn directory/collection handles are not people
    if (/^dir(\/|-|$)/i.test(handle) || /^(topic|groups?|pulse)\b/i.test(handle)) {
      stats.rejected.directory_or_nonperson++;
      continue;
    }
    if (seen.has(handle)) { stats.rejected.duplicate++; continue; }
    if (!parsed || !parsed.name) { stats.rejected.unparseable_title++; continue; }
    stats.parseableCount++;
    const titleHay = r.title || '';
    const snippetHay = r.snippet || '';
    const inTitle = match(titleHay, companyName);
    const inSnippet = match(snippetHay, companyName);
    if (!inTitle && !inSnippet) { stats.rejected.wrong_company++; continue; }
    // v1.3 role currency: keep only CURRENT roles at this company.
    // Title mentions are the indexed headline (current); snippet-only mentions
    // that carry past-role markers BEFORE the company name are dropped.
    const role = roleCurrency(inTitle, inSnippet, titleHay, snippetHay, companyName);
    if (role === 'past') { stats.rejected.past_role++; continue; }
    seen.add(handle);
    const cls = classifyDesignation(parsed.designation);
    const confidence = role === 'current' ? 0.85 : (role === 'snippet' ? 0.55 : 0.45);
    out.push({
      name: parsed.name,
      designation: parsed.designation,
      url, handle,
      urlVerified: true,
      currentEmployer: role,
      source: 'bing',
      sourceType: 'linkedin',
      confidence: confidence,
      cat: cls.cat, pri: cls.pri, score: cls.sc
    });
    stats.acceptedCount++;
  }
  return { people: out, stats };
}

function peopleFromOfficialSources(serp, website, companyName) {
  const out = [];
  const seen = new Set();
  const stats = {
    resultCount: (serp || []).length, acceptedCount: 0,
    rejected: { no_explicit_current_leader: 0, duplicate: 0 }
  };
  for (const r of (serp || [])) {
    const candidate = officialLeadershipCandidate(r, website, companyName);
    if (!candidate) { stats.rejected.no_explicit_current_leader++; continue; }
    const key = candidate.name.toLowerCase();
    if (seen.has(key)) { stats.rejected.duplicate++; continue; }
    seen.add(key);
    const cls = classifyDesignation(candidate.designation);
    out.push({
      name: candidate.name,
      designation: candidate.designation,
      url: '', handle: null, urlVerified: false,
      evidenceUrl: candidate.evidenceUrl,
      evidenceText: candidate.evidenceText,
      sourceType: 'official', source: 'official',
      verification: 'Official company source',
      currentEmployer: 'official', confidence: 0.8,
      cat: cls.cat, pri: cls.pri, score: cls.sc
    });
    stats.acceptedCount++;
  }
  return { people: out, stats };
}

function mergeEvidencePeople(base, additional) {
  for (const p of (additional || [])) {
    const existing = base.find(b =>
      (p.handle && b.handle === p.handle) ||
      (b.name || '').toLowerCase() === (p.name || '').toLowerCase());
    if (existing) {
      // A LinkedIn profile remains the preferred link, but keep the official
      // evidence URL as a second proof point when it exists.
      if (!existing.evidenceUrl && p.evidenceUrl) existing.evidenceUrl = p.evidenceUrl;
      continue;
    }
    base.push(p);
  }
  return base;
}

function makeDiscovery() {
  return {
    queryCount: 0, rawResultCount: 0, profileResultCount: 0,
    parseableCount: 0, acceptedCount: 0,
    queries: [],
    rejected: {
      bad_profile_url: 0, directory_or_nonperson: 0, duplicate: 0,
      unparseable_title: 0, wrong_company: 0, past_role: 0,
      no_explicit_current_leader: 0
    },
    official: { used: false, pages: 0, candidates: 0, accepted: 0, blocked: 0, errors: 0, visited: [] },
    sourceStates: {}, fallbackUsed: false, officialFallbackUsed: false
  };
}

function recordSearch(discovery, meta) {
  if (!meta) return;
  discovery.queryCount++;
  discovery.rawResultCount += Number(meta.resultCount || 0);
  discovery.profileResultCount += Number(meta.profileResultCount || 0);
  if (meta.query && discovery.queries.length < 8 && !discovery.queries.includes(meta.query)) {
    discovery.queries.push(String(meta.query).slice(0, 240));
  }
  const state = meta.state || 'ok';
  discovery.sourceStates[state] = (discovery.sourceStates[state] || 0) + 1;
}

function applyCandidateStats(discovery, stats) {
  if (!stats) return;
  discovery.parseableCount = Number(stats.parseableCount || 0);
  discovery.acceptedCount = Number(stats.acceptedCount || 0);
  for (const [reason, count] of Object.entries(stats.rejected || {})) {
    if (reason === 'not_profile') continue;
    discovery.rejected[reason] = Number(count || 0);
  }
}

function buildReviewOutcome(comp) {
  const outcome = classifyOutcome((comp.people || []).length, comp.discovery || makeDiscovery());
  comp.outcome = outcome.outcome;
  comp.reviewReason = outcome.reason;
  comp.reviewDetail = outcome.detail;
}

function mergeAiPeople(base, aiPeople, serp, companyName) {
  const serpHandles = new Set((serp || []).map(r => linkedinHandle(r.url)).filter(Boolean));
  let dropped = 0;
  for (const p of (aiPeople || [])) {
    if (!p || !p.name) continue;
    // v1.3: the AI is instructed to emit current:true only for people who
    // hold that designation at this company NOW. Anything marked false (a
    // past role) is dropped outright.
    if (p.current === false) continue;
    const name = cell(p.name).slice(0, 120);
    if (!name) continue;
    let desig = cell(p.designation).slice(0, 120);
    let url = String(p.linkedin_url || '').trim();
    if (url && !isLinkedInProfile(url)) url = '';
    const handle = url ? linkedinHandle(url) : null;
    if (handle && !serpHandles.has(handle)) url = '';      // never keep an unverifiable URL
    const verified = !!(handle && serpHandles.has(handle) && url);

    // v1.4.1 anti-hallucination gate: the model's output is only a proposal.
    // A person is kept when this company's own corpus mentions them; the role
    // then comes from that result, never from the model's "current" claim.
    let evidence = null;
    if (verified) {
      const idx = (serp || []).findIndex(r => linkedinHandle(r.url) === handle);
      if (idx !== -1) {
        const r = serp[idx];
        const role = roleCurrency(companyMatch(r.title || '', companyName),
          companyMatch(r.snippet || '', companyName), r.title || '', r.snippet || '', companyName);
        if (role !== 'past') evidence = { index: idx, role };
      }
    } else {
      evidence = nameEvidence(name, serp, companyName);
    }
    if (!evidence) {
      dropped++;   // invented, out-of-company, or past-role person
      continue;
    }

    const existing = base.find(b =>
      (handle && b.handle === handle) ||
      b.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!existing.designation && desig) existing.designation = desig;
      existing.confidence = Math.min(1, Math.max(existing.confidence, Number(p.confidence) || 0.5));
      continue;
    }
    const cls = classifyDesignation(desig || '');
    base.push({
      name, designation: desig, url, handle: handle || null,
      urlVerified: verified,
      currentEmployer: evidence.role,
      source: verified ? 'bing+ai' : 'ai+corpus',
      sourceType: verified ? 'linkedin' : 'ai',
      confidence: Math.min(1, (Number(p.confidence) || 0.5) * (verified ? 1 : 0.85)),
      cat: cls.cat, pri: cls.pri, score: Math.round(cls.sc * (verified ? 1 : 0.85))
    });
  }
  return { people: base, dropped };
}

function finalizePeople(people, domain, includeEmails, hunterData) {
  for (const p of people) {
    const cls = classifyDesignation(p.designation || '');
    p.cat = cls.cat; p.pri = cls.pri;
    p.score = cls.sc + seniorityBonus(p.designation || '') + (p.urlVerified ? 6 : 0) +
      Math.round((p.confidence || 0.5) * 8);
    // currency demotion: possibly-past roles sink below verified-current ones
    if (p.currentEmployer === 'review-past') p.score -= 14;
    else if (p.currentEmployer === 'snippet') p.score -= 5;
    p.priority = 'P' + (p.pri || 5);
    if (includeEmails && domain) {
      let em = null;
      if (hunterData) {
        em = matchHunterEmail(p.name, hunterData.emails, hunterData.patternTemplate, domain);
      }
      if (!em) em = emailFor(p.name, domain);
      if (em) { p.email = em.email; p.emailStatus = em.status; }
    }
  }
  people.sort((a, b) => (a.pri || 9) - (b.pri || 9) || (b.score || 0) - (a.score || 0));
  return people.slice(0, 12);
}

// Common single-token countries seen as the whole HQ line ("Headquarters\nIndia")
const KNOWN_COUNTRIES = new Set(['india', 'usa', 'united states', 'united kingdom', 'uk',
  'canada', 'australia', 'germany', 'france', 'netherlands', 'spain', 'italy',
  'singapore', 'japan', 'china', 'south korea', 'brazil', 'mexico', 'uae',
  'united arab emirates', 'saudi arabia', 'israel', 'sweden', 'switzerland',
  'ireland', 'poland', 'new zealand', 'south africa', 'nigeria', 'kenya',
  'indonesia', 'malaysia', 'philippines', 'thailand', 'vietnam', 'pakistan',
  'bangladesh', 'sri lanka']);

function countryFromHq(hq) {
  if (!hq) return '';
  const parts = String(hq).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  // Only a recognised country may leave this function. A truncated address tail
  // ("… Kalpataru Inspire, Off") is not a country, and guessing one would break
  // the no-invented-facts rule.
  return KNOWN_COUNTRIES.has(last.toLowerCase()) ? last : '';
}

// Precision/recall helpers for company resolution (slugScore, overlapTokens,
// kebabName, looseResolveMatch) live in lib/parse.js — unit-tested there.

/**
 * Tier-1 resolver: load linkedin.com/company/<kebab-name>/about/ and verify.
 * The guessed URL is only ACCEPTED when the loaded page's real name shares at
 * least one token with the query — otherwise it is discarded (never fabricated).
 * On success this also captured the company facts in the same page load.
 */
async function guessCompanyByName(name) {
  const slug = kebabName(name);
  if (!slug) return null;
  const url = 'https://www.linkedin.com/company/' + slug + '/about/';
  const tabId = await ensureTab('li', url);
  await waitForTabLoad(tabId, 28000);
  await sleep(1400);
  let out = null;
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractLinkedInCompany });
    out = frames && frames[0] && frames[0].result;
  } catch (e) { out = null; }
  if (!out || !out.found || !out.name) return null;
  if (overlapTokens(out.name, name) === 0) return null; // a different company lives at that slug
  return { slug: slug, data: out };
}

// ------------------------------------------------------- main per-company ----

// Hunter.io lookup with a per-domain cache (quota-friendly: one request per
// domain across all runs). Returns {emails, patternTemplate} or null.
async function hunterLookup(domain, apiKey) {
  if (!domain || !apiKey) return null;
  const cacheKey = 'hunter:' + domain;
  try {
    const st = await chrome.storage.local.get([cacheKey]);
    if (st[cacheKey]) return st[cacheKey];
  } catch (e) { /* cache miss is fine */ }
  const data = await hunterDomainSearch(domain, apiKey);
  if (data) {
    try { await chrome.storage.local.set({ [cacheKey]: data }); } catch (e) { /* ignore */ }
  }
  return data;
}

const OFFICIAL_PATHS = [
  '/leadership', '/company/leadership', '/about-us/leadership', '/know-us/leadership',
  '/about-us/board-of-directors', '/board-of-directors', '/management', '/company/management',
  '/en-us/company/leadership', '/en/company/leadership', '/our-leadership', '/who-we-are',
  '/leadership-team', '/about/leadership', '/about/management', '/executive-team',
  '/about/executive-team', '/people', '/about/people', '/our-team', '/team',
  '/governance', '/leadership-and-governance'
];

function isOfficialCandidateUrl(url) {
  try {
    const path = new URL(String(url)).pathname.toLowerCase();
    return !/(?:^|\/)(?:careers|jobs|login|signin|support|blog|news|press|privacy|terms|contact)(?:\/|$)/.test(path);
  } catch (e) {
    return false;
  }
}

/**
 * Bounded crawl of the company's own leadership pages. LinkedIn company pages
 * are frequently walled by Cloudflare; the company site usually is not. Only
 * explicit name + current leadership role pairs from the verified domain are
 * returned, and no LinkedIn URL is ever created here.
 */
async function readOfficialLeadership(website, companyName) {
  const domain = domainFromWebsite(website);
  const stats = {
    used: true, pages: 0, candidates: 0, accepted: 0, blocked: 0, errors: 0, states: {},
    rejected: { no_explicit_current_leader: 0 }, visited: [], website: '',
    facts: { employees: '', industry: '', hq: '', country: '', linkedinUrl: '' }
  };
  const people = [];
  const mergePageFacts = (out) => {
    const pageFacts = companyFactsFromPage(out.page || { title: out.title || '', description: '', text: '' });
    for (const key of ['employees', 'industry', 'hq', 'country', 'linkedinUrl']) {
      if (!stats.facts[key] && pageFacts[key]) stats.facts[key] = pageFacts[key];
    }
  };
  if (!domain) return { people, stats };
  const proto = /^http:\/\//i.test(String(website)) ? 'http:' : 'https:';
  const base = proto + '//' + domain;
  let officialWebsite = website;
  const seen = new Set();
  const queue = [base + '/'];
  let pathsAdded = false;

  while (queue.length && stats.pages < 12 && people.length < 3) {
    if (!S.job.running || S.job.paused) throw new Error('paused');
    const url = queue.shift();
    const norm = String(url).replace(/#.*$/, '').replace(/\/+$/, '');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    let out = null;
    try {
      const tabId = await ensureTab('official', url);
      await waitForTabLoad(tabId, 22000);
      await sleep(900);
      stats.pages++;
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractOfficialLeadership });
      out = frames && frames[0] && frames[0].result;
    } catch (e) {
      stats.errors = (stats.errors || 0) + 1;
      stats.states['official-error'] = (stats.states['official-error'] || 0) + 1;
      if (!queue.length && !pathsAdded && !people.length) {
        pathsAdded = true;
        for (const p of OFFICIAL_PATHS) queue.push(base + p);
      }
      continue;
    }
    if (!out) {
      stats.errors = (stats.errors || 0) + 1;
      stats.states['official-unreadable'] = (stats.states['official-unreadable'] || 0) + 1;
      if (!queue.length && !pathsAdded) {
        pathsAdded = true;
        for (const p of OFFICIAL_PATHS) queue.push(base + p);
      }
      continue;
    }
    if (out.blocked) {
      stats.blocked++;
      stats.states['official-blocked'] = (stats.states['official-blocked'] || 0) + 1;
    } else {
      const finalUrl = out.url || url;
      try {
        const originalHost = new URL(officialWebsite).hostname.replace(/^www\./, '');
        const finalHost = new URL(finalUrl).hostname.replace(/^www\./, '');
        // A verified company site may redirect to its canonical domain (e.g.
        // redington.group → redingtongroup.com). Follow that domain for the rest
        // of the crawl only when the page still names the company.
        if (finalHost && finalHost !== originalHost &&
            (domainMatchesCompany(finalHost, companyName) || companyMatch(out.title || '', companyName))) {
          officialWebsite = finalUrl;
          stats.website = finalUrl;
        }
      } catch (e) { /* keep the original website */ }
      mergePageFacts(out);
      const pageCandidates = Array.isArray(out.candidates) ? out.candidates : [];
      stats.candidates += pageCandidates.length;
      let pageAccepted = 0;
      for (const candidate of pageCandidates) {
        const validated = officialPageCandidate({
          ...candidate,
          url: out.url || url,
          pageTitle: out.title || ''
        }, officialWebsite, companyName);
        if (!validated) { stats.rejected.no_explicit_current_leader++; continue; }
        if (people.some(p => p.name.toLowerCase() === validated.name.toLowerCase())) continue;
        people.push({
          ...validated,
          url: '', handle: null, urlVerified: false,
          currentEmployer: 'official', source: 'official',
          verification: 'Official company source',
          confidence: 0.8
        });
        stats.accepted++;
        pageAccepted++;
      }
      if (stats.visited.length < 12) {
        stats.visited.push({
          url: out.url || url, title: String(out.title || '').slice(0, 120),
          candidates: pageCandidates.length, accepted: pageAccepted
        });
      }
      if (people.length < 3) {
        for (const link of (out.links || []).slice(0, 3)) {
          if (!link || !link.url || !isOfficialCandidateUrl(link.url)) continue;
          const n = String(link.url).replace(/#.*$/, '').replace(/\/+$/, '');
          if (n && !seen.has(n)) queue.push(link.url);
        }
      }
    }
    // Known leadership paths are tried before generic about/company links.
    if (!pathsAdded && stats.pages >= 1 && !people.length) {
      pathsAdded = true;
      const extraPaths = OFFICIAL_PATHS
        .map(p => base + p)
        .filter(u => !seen.has(u.replace(/#.*$/, '').replace(/\/+$/, '')));
      queue.unshift(...extraPaths);
    }
  }
  // If the leadership page did not state company size/headquarters, make a
  // bounded pass over the company's own about/company pages. This also runs
  // when no leadership page was readable, but not when the site refused us
  // entirely. Facts are merged only when missing and never overwrite
  // LinkedIn-verified values.
  if ((!stats.facts.employees || !stats.facts.hq) && stats.pages >= stats.blocked) {
    let factBase = base;
    try { factBase = new URL(officialWebsite).origin; } catch (e) { /* keep base */ }
    const factPaths = stats.facts.hq
      ? ['/about-us', '/investors', '/about', '/company', '/who-we-are', '/investor-relations']
      // A contact page states the registered/corporate address far more often
      // than a marketing "about" page does, so try it first when HQ is missing.
      : ['/contact-us', '/contact', '/about-us', '/about', '/investors'];
    let attempts = 0;
    for (const p of factPaths) {
      if (attempts >= 4 || stats.pages >= 16) break;
      if (stats.facts.employees && stats.facts.hq) break;
      if (!S.job.running || S.job.paused) throw new Error('paused');
      const url = factBase + p;
      const norm = String(url).replace(/#.*$/, '').replace(/\/+$/, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      attempts++;
      try {
        const tabId = await ensureTab('official', url);
        await waitForTabLoad(tabId, 18000);
        await sleep(700);
        stats.pages++;
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractOfficialLeadership });
        const out = frames && frames[0] && frames[0].result;
        if (out && !out.blocked) mergePageFacts(out);
      } catch (e) { /* best-effort facts */ }
    }
  }
  return { people, stats };
}

/** Probe deterministic company-name domains when search did not yield a website. */
async function probeWebsiteCandidates(companyName) {
  const candidates = websiteCandidates(companyName).slice(0, 5);
  for (const url of candidates) {
    if (!S.job.running || S.job.paused) throw new Error('paused');
    try {
      const tabId = await ensureTab('official', url);
      await waitForTabLoad(tabId, 18000);
      await sleep(700);
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractOfficialLeadership });
      const out = frames && frames[0] && frames[0].result;
      if (!out || out.blocked) continue;
      const finalUrl = out.url || url;
      let finalHost = '';
      try { finalHost = new URL(finalUrl).hostname; } catch (e) { finalHost = new URL(url).hostname; }
      if (!domainMatchesCompany(finalHost, companyName) && !companyMatch(out.title || '', companyName)) continue;
      return { url: finalUrl, host: finalHost.replace(/^www\./, '') };
    } catch (e) { /* try the next candidate */ }
  }
  return null;
}

async function researchCompany(item, idx) {
  // v1.1: on retry, update the existing results entry instead of adding a
  // duplicate row (v1.0 bug: "Retry failed" created a second entry).
  let comp = null;
  const existingIdx = S.job.results.findIndex(c =>
    (item.slug && c.slug === item.slug) || c.input === item.input);
  if (existingIdx !== -1) {
    comp = S.job.results[existingIdx];
    comp.status = 'working';
    comp.error = '';
    comp.people = [];
  } else {
    comp = {
      id: item.id,
      input: item.input,
      type: item.type,
      slug: item.slug || null,
      url: item.slug ? ('https://www.linkedin.com/company/' + item.slug + '/') : '',
      name: item.name || titleCaseSlug(item.slug) || '',
      industry: '', size: '', hq: '', website: '', websiteSource: '', country: '',
      factSource: 'none',
      aiDropped: 0,
      people: [], status: 'working', error: '', finishedAt: null,
      discovery: makeDiscovery(), outcome: '', reviewReason: '', reviewDetail: ''
    };
    S.job.results.push(comp);
  }
  comp.discovery = makeDiscovery();
  comp.outcome = '';
  comp.reviewReason = '';
  comp.reviewDetail = '';
  comp.websiteSource = comp.websiteSource || '';
  await persist();

  const companyName = () => comp.name || item.name || titleCaseSlug(item.slug) || '';
  const search = async (query) => {
    try {
      const out = await bingSearch(query);
      recordSearch(comp.discovery, out.meta);
      return out.results;
    } catch (e) {
      const code = String(e && e.code || 'bing-extractor-error');
      comp.discovery.sourceStates[code] = (comp.discovery.sourceStates[code] || 0) + 1;
      comp.error = String(e && e.message || e).slice(0, 200);
      comp.status = 'failed';
      buildReviewOutcome(comp);
      await persist();
      throw e;
    }
  };

  // ---- 1. resolve slug for plain names (3-tier, recall-first) ---------------
  let preScan = null;
  if (item.type === 'name') {
    if (SETTINGS.deepScan) {
      // Tier 1 — direct slug guess + on-page verification (also captures facts)
      preScan = await guessCompanyByName(comp.name);
      if (preScan) {
        comp.slug = preScan.slug;
        comp.url = 'https://www.linkedin.com/company/' + comp.slug + '/';
      }
    }
    if (!comp.slug) {
      // Tier 2 — Bing resolve with recall-friendly matching + scoring
      const candidates = [];
      const collect = (list) => {
        for (const r of list) {
          const slug = slugFromUrl(r.url);
          if (!slug) continue;
          if (slug.toLowerCase() === 'company' || slug.toLowerCase().startsWith('page')) continue;
          const loose = looseResolveMatch(r.title || '', r.snippet || '', slug, comp.name);
          if (loose <= 0) continue;
          candidates.push({ slug: slug, score: loose * 10 + slugScore(slug, comp.name) });
        }
      };
      const addResolve = async (query) => {
        const list = await search(query);
        collect(list);
        if (!comp.website) {
          const web = inferWebsiteFromSerp(list, comp.name);
          if (web) { comp.website = web.url; comp.websiteSource = 'search'; }
        }
        return list;
      };
      await addResolve('"' + stripQuotes(comp.name) + '" site:linkedin.com/company');
      if (!candidates.length) await addResolve(stripQuotes(comp.name) + ' site:linkedin.com/company');
      if (!candidates.length) await addResolve(comp.name + ' linkedin company page');
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score); // stable — ties keep SERP order
        comp.slug = candidates[0].slug;
        comp.url = 'https://www.linkedin.com/company/' + candidates[0].slug + '/';
      }
    }
  }

  // ---- 2. deep scan the LinkedIn company page ------------------------------
  let liData = null;
  if (SETTINGS.deepScan && comp.slug) {
    if (preScan && preScan.slug === comp.slug && preScan.data && preScan.data.found) {
      liData = preScan.data; // facts were already captured while resolving
    } else {
      liData = await readLinkedInCompany(comp.slug);
    }
    if (liData && !liData.authwall && liData.found) {
      if (liData.name && liData.name.length > 1 && overlapTokens(liData.name, companyName()) > 0) comp.name = liData.name;
      if (liData.industry) comp.industry = liData.industry;
      if (liData.size) comp.size = liData.size;
      if (liData.hq) comp.hq = liData.hq;
      if (liData.website) { comp.website = liData.website; comp.websiteSource = 'linkedin'; }
      comp.factSource = 'linkedin';
    } else if (liData && liData.authwall) {
      comp.factSource = 'none'; // fall back to AI/SERP facts
    }
  }

  // ---- 3. scoped Bing queries for decision-makers --------------------------
  // A walled LinkedIn page may leave the website unknown. One bounded
  // company-name query is enough to find the company's own homepage, which is
  // a candidate for the source-aware fallback (still domain-validated later).
  if (!comp.website && SETTINGS.deepScan) {
    const webSerp = await search(stripQuotes(companyName()) + ' official website');
    const web = inferWebsiteFromSerp(webSerp, companyName());
    if (web) { comp.website = web.url; comp.websiteSource = 'search'; }
    if (!comp.website) {
      const probed = await probeWebsiteCandidates(companyName());
      if (probed) { comp.website = probed.url; comp.websiteSource = 'search'; }
    }
  }

  let serp = [];
  const allowPartial = (item.type === 'name' && !comp.slug);
  const queries = buildQueries({ type: item.type, name: companyName(), slug: item.slug });
  for (const q of queries) {
    const res = await search(q);
    serp = serp.concat(res);
    if (S.job.paused) throw new Error('paused');
  }

  // Measure usable candidates before deciding whether recovery is needed. Raw
  // result/profile counts are not enough: a page full of wrong-company or past
  // profiles used to suppress this fallback and yield an unexplained empty row.
  let profilePass = peopleFromSerp(serp, companyName(), allowPartial);
  applyCandidateStats(comp.discovery, profilePass.stats);
  if (profilePass.people.length < 2 && (SETTINGS.scanMode || 'standard') !== 'deep') {
    comp.discovery.fallbackUsed = true;
    const extra = await search('site:linkedin.com/in "' + stripQuotes(companyName()) +
      '" ("AI" OR "Machine Learning" OR "Digital" OR "Innovation" OR "Engineering")');
    serp = serp.concat(extra);
    profilePass = peopleFromSerp(serp, companyName(), allowPartial);
    applyCandidateStats(comp.discovery, profilePass.stats);
  }

  // LinkedIn profiles are not consistently indexed by Bing. If the company
  // page supplied a website, make a bounded pass over that company's own
  // durable leadership/governance pages. Only explicit current name + role statements
  // from the corporate domain are accepted, and no profile URL is invented.
  let officialPass = { people: [], stats: null };
  const websiteUsable = !!(comp.website &&
    (comp.websiteSource === 'linkedin' || comp.websiteSource === 'search'));
  if (profilePass.people.length < 2 && websiteUsable) {
    comp.discovery.officialFallbackUsed = true;
    comp.discovery.official.used = true;
    const scan = await readOfficialLeadership(comp.website, companyName());
    if (scan.stats.website) { comp.website = scan.stats.website; comp.websiteSource = 'search'; }
    const facts = scan.stats.facts || {};
    let officialFact = false;
    if (!comp.size && facts.employees) { comp.size = facts.employees; officialFact = true; }
    if (!comp.industry && facts.industry) { comp.industry = facts.industry; officialFact = true; }
    if (!comp.hq && facts.hq) { comp.hq = facts.hq; officialFact = true; }
    if (!comp.country && facts.country) { comp.country = facts.country; officialFact = true; }
    if (!comp.url && facts.linkedinUrl) { comp.url = facts.linkedinUrl; comp.linkedinSource = 'official-site'; }
    if (officialFact && comp.factSource === 'none') comp.factSource = 'official';
    comp.discovery.official.pages = scan.stats.pages;
    comp.discovery.official.candidates = scan.stats.candidates;
    comp.discovery.official.accepted = scan.stats.accepted;
    comp.discovery.official.blocked = scan.stats.blocked;
    comp.discovery.official.errors = scan.stats.errors || 0;
    comp.discovery.official.visited = scan.stats.visited || [];
    for (const [state, count] of Object.entries(scan.stats.states || {})) {
      comp.discovery.sourceStates[state] = (comp.discovery.sourceStates[state] || 0) + Number(count || 0);
    }
    comp.discovery.rejected.no_explicit_current_leader =
      Number(scan.stats.rejected && scan.stats.rejected.no_explicit_current_leader || 0);
    officialPass = {
      people: scan.people,
      stats: { acceptedCount: scan.stats.accepted, rejected: scan.stats.rejected }
    };
    // Keep one bounded Bing search as a second chance for sites whose own
    // pages are JS-only or blocked. It is never used when the direct crawl
    // already produced evidence.
    if (!officialPass.people.length) {
      const officialQueries = buildOfficialLeadershipQueries(comp.website);
      if (officialQueries.length) {
        const officialSerp = await search(officialQueries[0]);
        const bingPass = peopleFromOfficialSources(officialSerp, comp.website, companyName());
        if (bingPass.people.length) {
          officialPass = bingPass;
          comp.discovery.official.accepted = Number(bingPass.stats.acceptedCount || 0);
        }
      }
    }
  }
  const basePeople = mergeEvidencePeople(profilePass.people, officialPass.people);
  comp.discovery.acceptedCount = profilePass.stats.acceptedCount +
    Number(officialPass.stats && officialPass.stats.acceptedCount || 0);

  // ---- 4. AI enrichment ----------------------------------------------------
  let aiNote = '';
  const prov = SETTINGS.provider || 'none';
  const hasKey = prov === 'custom'
    ? !!(SETTINGS.keys && SETTINGS.keys.custom && SETTINGS.customBase)
    : !!(SETTINGS.keys && SETTINGS.keys[prov]);
  // Grounded research helps twice: when people are scarce AND when the
  // LinkedIn page was walled and company facts are still missing (RC7).
  const groundedCandidate = prov === 'gemini' && hasKey &&
    (basePeople.length < 2 || comp.factSource === 'none');
  if (SETTINGS.aiAssist !== false && prov !== 'none' && hasKey) {
    try {
      const out = await aiResearch({
        provider: prov, settings: SETTINGS,
        companyName: companyName(),
        companyUrl: comp.url,
        serp,
        grounded: groundedCandidate
      });
      // grounded citations are real URLs — add them to the corpus before merging
      const extraSerp = (out.cites || []).map(c => ({ title: c.title, url: c.url, snippet: 'AI grounding citation' }));
      serp = serp.concat(extraSerp);
      const merged = mergeAiPeople(basePeople, out.people, serp, companyName());
      comp.people = merged.people;
      comp.aiDropped = merged.dropped;
      // facts: never overwrite LinkedIn-verified facts; fill gaps only
      const c = out.company || {};
      if (!comp.industry && c.industry) comp.industry = cell(c.industry);
      if (!comp.size && c.size) comp.size = cell(c.size);
      if (!comp.hq && c.hq) comp.hq = cell(c.hq);
      if (!comp.website && c.website) { comp.website = cell(c.website); comp.websiteSource = 'ai'; }
      if (!comp.country && c.country) comp.country = cell(c.country);
      if (comp.factSource === 'none' && (comp.industry || comp.size || comp.hq)) comp.factSource = 'ai';
      aiNote = (out.note || 'ai') +
        (merged.dropped ? ' · ' + merged.dropped + ' AI name(s) dropped — no corpus evidence' : '');
    } catch (e) {
      aiNote = 'ai-failed: ' + String(e.message || e).slice(0, 120);
      comp.people = basePeople;
    }
  } else {
    comp.people = basePeople;
  }

  // ---- 5. finalize ---------------------------------------------------------
  if (!comp.website) comp.website = '';
  // RC5: recover company size from Bing snippets when LinkedIn was walled
  if (!comp.size) {
    for (const r of serp) {
      const s = extractSizeFromText((r.title || '') + ' ' + (r.snippet || ''));
      if (s) {
        comp.size = s;
        if (comp.factSource === 'none') comp.factSource = 'search';
        break;
      }
    }
  }
  const domain = domainFromWebsite(comp.website);
  if (!comp.country && comp.hq) comp.country = countryFromHq(comp.hq);
  // v1.3 emails: optional Hunter.io (free key) gives real addresses / verified
  // domain patterns; without it, pattern estimates are used and flagged.
  let hunterData = null;
  if (SETTINGS.includeEmails !== false && domain &&
      SETTINGS.keys && SETTINGS.keys.hunter) {
    hunterData = await hunterLookup(domain, SETTINGS.keys.hunter);
  }
  comp.people = finalizePeople(comp.people, domain, SETTINGS.includeEmails !== false, hunterData);
  comp.aiNote = aiNote;
  buildReviewOutcome(comp);
  comp.status = 'done';
  comp.finishedAt = Date.now();
  S.job.doneCount += 1;
  S.job.perCompanyMs = S.job.startedAt ?
    Math.round((Date.now() - S.job.startedAt) / Math.max(1, S.job.doneCount)) : 0;
  await persist();
}

// ------------------------------------------------------------- the pump ----

async function pump() {
  if (S.busy || !S.job.running || S.job.paused) return;
  const myRun = S.runId; // a newer Start invalidates this loop generation
  S.busy = true;
  try {
    while (S.job.running && !S.job.paused && S.runId === myRun &&
           S.job.cursor < S.job.queue.length) {
      const item = S.job.queue[S.job.cursor];
      if (!item) { S.job.cursor++; continue; }
      if (item.status === 'queued') {
        item.status = 'working';
        item.startedAt = Date.now();
        await persist();
        try {
          await researchCompany(item, S.job.cursor);
          if (S.runId !== myRun) break; // superseded mid-research — leave state to the new run
          item.status = 'done';
        } catch (e) {
          if (S.runId !== myRun) break;
          item.status = 'failed';
          item.error = String(e.message || e).slice(0, 200);
          const comp = S.job.results.find(c =>
            (item.slug && c.slug === item.slug) || c.input === item.input);
          if (comp) {
            const alreadyRecorded = comp.status === 'failed' && comp.error === item.error;
            comp.status = 'failed';
            comp.error = item.error;
            if (!comp.discovery) comp.discovery = makeDiscovery();
            if (!alreadyRecorded) {
              const code = String(e && e.code || (S.job.paused ? 'paused' : 'research-error'));
              comp.discovery.sourceStates[code] = (comp.discovery.sourceStates[code] || 0) + 1;
            }
            buildReviewOutcome(comp);
          }
        }
        S.job.cursor++;
        await persist();
        setBadge();
        await sleep(jitter(600));
      } else {
        S.job.cursor++; // skip already-done/failed items on resume
      }
    }
    if (S.runId === myRun && S.job.running && !S.job.paused && S.job.cursor >= S.job.queue.length) {
      S.job.running = false;
      S.job.finishedAt = Date.now();
      const done = S.job.queue.filter(q => q.status === 'done').length;
      notify('ls-done', 'LeadScout finished',
        done + ' of ' + S.job.queue.length + ' companies researched. Open LeadScout to download the CSV.');
      stopHeartbeat();
      await closeWorkerTabs();
      await persist();
      setBadge();
    }
  } finally {
    S.busy = false;
    // a newer Start was requested while this loop was finishing — kick it now
    if (S.job.running && !S.job.paused && S.runId !== myRun) pump();
  }
}

function startHeartbeat() {
  stopHeartbeat();
  S.heartbeat = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
  }, 20000);
}
function stopHeartbeat() {
  if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
}

// v1.4: close the hidden worker tabs when the queue stops — frees memory
async function closeWorkerTabs() {
  for (const key of ['tabBing', 'tabLI', 'tabOfficial']) {
    const id = S[key];
    if (id) {
      try { await chrome.tabs.remove(id); } catch (e) { /* already closed */ }
      S[key] = null;
    }
  }
}

// ---------------------------------------------------------- message router ----

// ------------------------------------------------- workspace / capture ----

const PROFILE_URL_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[^/?#]+/i;
const CAPTURE_MENU_ID = 'leadscout-capture';
const RESOLVE_GAP_MS = 1900;
let lastResolveAt = 0;
let resolveChain = Promise.resolve();

function cleanProfileUrl(url) {
  const m = String(url || '').match(PROFILE_URL_RE);
  if (!m) return '';
  try {
    const u = new URL(m[0]);
    return 'https://www.linkedin.com' + u.pathname.replace(/\/+$/, '') + '/';
  } catch (e) { return ''; }
}

/** Serialize resolver lookups and keep them at least ~1.9s apart. */
function paceResolve(task) {
  const run = resolveChain.then(async () => {
    const wait = Math.max(0, RESOLVE_GAP_MS - (Date.now() - lastResolveAt));
    if (wait) await sleep(wait);
    try { return await task(); } finally { lastResolveAt = Date.now(); }
  });
  resolveChain = run.catch(() => {});
  return run;
}

/** One Bing pass that never pauses the research queue. */
async function searchProfilesOnce(query) {
  const host = SETTINGS.searchHost || 'www.bing.com';
  const url = 'https://' + host + '/search?q=' + encodeURIComponent(query) + '&count=20';
  const tabId = await ensureTab('bing', url);
  await waitForTabLoad(tabId, 22000);
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: extractBingResults });
      res = frames && frames[0] && frames[0].result;
    } catch (e) { res = null; }
    if (res && (res.captcha || res.consent || (res.results || []).length)) break;
    await sleep(1300);
  }
  if (!res) return { state: 'error', results: [] };
  if (res.captcha) return { state: 'captcha', results: [] };
  if (res.consent) return { state: 'consent', results: [] };
  return { state: 'ok', results: (res.results || []).map(r => ({ ...r, url: decodeBingUrl(r.url) })) };
}

/**
 * Tier 2: search for the exact person and accept only a /in/ or /pub/ result
 * whose own title or snippet contains every name token.  Anything weaker is
 * returned as "needs review" — a profile URL is never constructed.
 */
async function resolveLinkedInRecord(record) {
  const rec = normalizeRecord(record);
  if (rec.linkedinUrl) return { status: 'direct', url: rec.linkedinUrl, state: 'already' };
  const query = linkedinSearchQuery(rec);
  if (!query) return { status: 'review', url: '', state: 'no_name' };
  return paceResolve(async () => {
    const out = await searchProfilesOnce(query);
    if (out.state !== 'ok') return { status: 'review', url: '', state: out.state, query };
    const tokens = [rec.firstName, rec.lastName]
      .filter(Boolean).map(t => t.toLowerCase()).filter(t => t.length > 1);
    const hit = out.results.find(r => {
      const profile = cleanProfileUrl(r.url);
      if (!profile) return false;
      const hay = (String(r.title || '') + ' ' + String(r.snippet || '')).toLowerCase();
      return tokens.length ? tokens.every(t => hay.includes(t)) : false;
    });
    if (!hit) return { status: 'review', url: '', state: 'no_match', query };
    return { status: 'auto', url: cleanProfileUrl(hit.url), state: 'ok', query };
  });
}

function setupWorkspaceMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CAPTURE_MENU_ID,
      title: 'Extract prospect to LeadScout',
      contexts: ['selection', 'page']
    }, () => { void chrome.runtime.lastError; });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ping') {
        // liveness probe from the popup — also confirms module state loaded
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      } else if (msg.type === 'workspace:extract') {
        let tab = null;
        if (msg.tabId) { try { tab = await chrome.tabs.get(msg.tabId); } catch (e) { tab = null; } }
        if (!tab) {
          const list = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tab = (list && list[0]) || null;
        }
        if (!tab || tab.id == null) { sendResponse({ ok: false, error: 'No active tab to read.' }); return; }
        if (!/^https?:/i.test(tab.url || '')) { sendResponse({ ok: false, error: 'Open a normal website tab — browser and extension pages cannot be read.' }); return; }
        let frames = null;
        try {
          frames = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            func: extractPageLeads,
            args: [{ selectionOnly: !!msg.selectionOnly }]
          });
        } catch (e) {
          sendResponse({ ok: false, error: 'This page blocks extension scripts. Try another tab.' });
          return;
        }
        const pageResult = frames && frames[0] && frames[0].result;
        if (!pageResult) { sendResponse({ ok: false, error: 'Nothing readable on this page.' }); return; }
        sendResponse({ ok: true, ...pageResult });
      } else if (msg.type === 'workspace:resolve') {
        const resolved = await resolveLinkedInRecord(msg.record || {});
        sendResponse({ ok: true, ...resolved });
      } else if (msg.type === 'start') {
        await loadAll();
        const items = (msg.items || []).map((it, i) => ({
          id: 'c' + Date.now() + '_' + i,
          type: it.type, slug: it.slug || null, name: it.name || null,
          input: it.input, status: 'queued', error: ''
        }));
        // merge with any leftover queued items, keep existing results
        const leftovers = S.job.queue.filter(q => q.status === 'queued');
        S.job.queue = leftovers.concat(items);
        S.job.cursor = 0;
        S.runId++; // invalidate any in-flight run generation
        S.job.running = true;
        S.job.paused = false;
        S.job.attention = null;
        S.job.startedAt = Date.now();
        S.job.finishedAt = null;
        S.job.doneCount = 0;
        S.job.perCompanyMs = 0;
        await persist();
        setBadge();
        startHeartbeat();
        pump();
        sendResponse({ ok: true, count: S.job.queue.length });
      } else if (msg.type === 'pause') {
        S.job.paused = true;
        await persist();
        sendResponse({ ok: true });
      } else if (msg.type === 'resume') {
        S.job.paused = false;
        S.job.attention = null;
        // companies that were mid-flight (or aborted) when paused go back to queued
        const cur = S.job.queue[S.job.cursor];
        if (cur && cur.status === 'working') cur.status = 'queued';
        for (const q of S.job.queue) {
          if (q.status === 'failed' && /paused/i.test(q.error || '')) {
            q.status = 'queued';
            q.error = '';
          }
        }
        // A paused company is marked failed and the pump has already advanced
        // its cursor. Rewind to the first queued item so Resume cannot skip
        // that company and finish with a permanently stale review row.
        const firstQueued = S.job.queue.findIndex(q => q.status === 'queued');
        if (firstQueued !== -1) S.job.cursor = firstQueued;
        await persist();
        startHeartbeat();
        pump();
        sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        S.job.running = false;
        S.job.paused = false;
        S.job.finishedAt = Date.now();
        stopHeartbeat();
        await closeWorkerTabs();
        await persist();
        setBadge();
        sendResponse({ ok: true });
      } else if (msg.type === 'clearResults') {
        S.job.queue = [];
        S.job.results = [];
        S.job.cursor = 0;
        S.job.running = false;
        S.job.paused = false;
        S.job.attention = null;
        await persist();
        setBadge();
        sendResponse({ ok: true });
      } else if (msg.type === 'getSettings') {
        await loadAll();
        sendResponse({ ok: true, settings: SETTINGS });
      } else if (msg.type === 'setSettings') {
        const incomingMeta = msg.settings.keyMeta !== undefined
          ? normalizeKeyMeta(msg.settings.keyMeta)
          : normalizeKeyMeta(SETTINGS.keyMeta);
        SETTINGS = {
          ...DEFAULT_SETTINGS, ...msg.settings,
          keys: { ...DEFAULT_SETTINGS.keys, ...(msg.settings.keys || {}) },
          keyMeta: incomingMeta
        };
        await saveSettings();
        sendResponse({ ok: true });
      } else if (msg.type === 'addCurrentPage') {
        const tabId = S.lastActiveTab;
        if (!tabId) {
          sendResponse({ ok: false, error: 'No active tab seen yet — visit a LinkedIn company page, then click again.' });
        } else {
          let tab = null;
          try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; }
          const url = tab && tab.url ? tab.url : '';
          if (!tab || !/linkedin\.com\/company\//i.test(url)) {
            sendResponse({ ok: false, error: 'Open a LinkedIn company page first' });
          } else {
            let line = url;
            try {
              const frames = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: extractLinkedInCompany
              });
              const r = frames && frames[0] && frames[0].result;
              if (r && r.name) line = r.name + ' - ' + url;
            } catch (e) {
              // fall back to URL-only line; the pipeline title-cases the slug
            }
            sendResponse({ ok: true, line: line });
          }
        }
      } else if (msg.type === 'testAI') {
        await loadAll();
        const out = await aiTestKey(msg.provider, SETTINGS);
        sendResponse({ ok: true, message: out });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async sendResponse
});

// ------------------------------------------------------------- lifecycle ----

// Track the last active tab so the popup's "Add current page" works without
// needing the tabs-query API (and without asking for extra permissions).
chrome.tabs.onActivated.addListener((info) => {
  try { S.lastActiveTab = info.tabId; } catch (e) { /* ignore */ }
});

// Chrome 116–119 require alarm periods of at least one minute. Keep the
// documented Chrome 116+ support truthful; active queues are also driven by
// the in-memory pump, so this only affects restart recovery cadence.
chrome.alarms.create('ls-pump', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ls-pump' && S.job.running && !S.job.paused) pump();
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadAll();
  await saveSettings();
  setupWorkspaceMenu();
  // Keep the toolbar click opening the popup; the workspace opens from inside
  // it, from the page context menu, or from its own panel button.
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) { /* older browser */ }
  }
});

// Capture from the page: store the payload, then open the workspace panel.
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info || info.menuItemId !== CAPTURE_MENU_ID || !tab || tab.id == null) return;
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageLeads,
        args: [{ selectionOnly: !!info.selectionText }]
      });
      const captured = (frames && frames[0] && frames[0].result) || null;
      await chrome.storage.local.set({
        workspacePending: {
          at: Date.now(),
          pageUrl: tab.url || '',
          title: tab.title || '',
          selectionText: info.selectionText || '',
          ...(captured || {})
        }
      });
      if (chrome.sidePanel && chrome.sidePanel.open && tab.windowId != null) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    } catch (e) { /* restricted page: the panel still works from its button */ }
  });
}

// Service-worker restart recovery: resume an interrupted job automatically.
(async () => {
  await loadAll();
  if (S.job.running) {
    // anything stuck in 'working' when the worker died goes back to queued
    for (const q of S.job.queue) if (q.status === 'working') q.status = 'queued';
    await persist();
    setBadge();
    startHeartbeat();
    pump();
  }
})();
