// LeadScout — pure logic shared by background, popup and results page.
// No chrome.* APIs in this module so it can be unit-tested with plain Node.

import { emptyKeyMeta } from './keys.js';

export const DEFAULT_SETTINGS = {
  provider: 'groq',            // groq | gemini | openrouter | custom | none
  keys: { groq: '', gemini: '', openrouter: '', custom: '', hunter: '' },
  // v1.5: saved/rotation dates per key (never a fabricated provider expiry)
  keyMeta: emptyKeyMeta(),
  // v1.4: model ids rotate as providers deprecate them — these overrides let
  // the user pin a current model without touching code ("latest always")
  models: { groq: '', gemini: '', openrouter: '', custom: '' },
  customBase: '',
  customModel: '',
  scanMode: 'standard',        // quick | standard | deep
  deepScan: true,              // open LinkedIn company page to read verified facts
  resolveProfiles: false,      // opt-in: per-person search inside a run (slow, uses Bing quota)
  maxResolvePerCompany: 6,     // hard cap so a 100-company run stays bounded
  includeEmails: true,         // pattern-estimated emails, always flagged as unverified
  fillMissing: false,          // write "Not Found" instead of an empty cell (opt-in)
  aiAssist: true,              // structure + enrich using the chosen provider
  bingDelayMs: 2200,           // base delay between Bing queries (±jitter)
  searchHost: 'www.bing.com',
  theme: 'dark'
};

export const PROVIDERS = {
  groq: {
    label: 'Groq (free tier — console.groq.com)',
    base: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    kind: 'openai'
  },
  gemini: {
    label: 'Google Gemini (free tier — aistudio.google.com, web-grounded)',
    base: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    model: 'gemini-2.0-flash',
    kind: 'gemini'
  },
  openrouter: {
    label: 'OpenRouter (free models — openrouter.ai)',
    base: 'https://openrouter.ai/api/v1/chat/completions',
    items: null,
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    kind: 'openai'
  },
  custom: { label: 'Custom OpenAI-compatible endpoint', kind: 'openai' },
  none: { label: 'No AI — Bing extraction only', kind: null }
};

// ---------------------------------------------------------------- input ----

const LI_COMPANY_RE = /https?:\/\/(?:[a-z]{2,4}\.)?linkedin\.com\/company\/([A-Za-z0-9_%\-\.]+)/i;

export function slugFromUrl(u) {
  const m = String(u || '').match(LI_COMPANY_RE);
  if (!m) return null;
  let slug = m[1].replace(/\.html?$/i, '');
  if (!slug) return null;
  return slug;
}

export function titleCaseSlug(slug) {
  const spaced = (slug || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/%20/g, ' ')
    .trim();
  return spaced.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1));
}

export function normalizeName(name) {
  return (name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Split raw textarea input into a deduped queue.
 * A line may be: a LinkedIn company URL, "Name - URL", or just a company name.
 */
export function parseInputs(raw) {
  const seen = new Set();
  const items = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim().replace(/^[\-\*\d\.\)\s]+/, '').replace(/[",]+$/, '').trim();
    if (!line) continue;
    const urlMatch = String(line).match(LI_COMPANY_RE);
    if (urlMatch) {
      const slug = slugFromUrl(urlMatch[0]);
      if (slug && !seen.has('u:' + slug.toLowerCase())) {
        seen.add('u:' + slug.toLowerCase());
        // Support "Company Name - https://..." / "Company Name | https://..." lines
        let displayName = null;
        const beforeUrl = line.slice(0, urlMatch.index).trim();
        if (beforeUrl) {
          displayName = normalizeName(beforeUrl.replace(/[-–—|:\s]+$/, '').trim());
        }
        items.push({ type: 'url', slug, name: displayName || null, input: urlMatch[0] });
      }
      continue;
    }
    // Strip a trailing URL if someone pasted "Name https://..." on one line
    let name = normalizeName(line.replace(LI_COMPANY_RE, '').replace(/\s{2,}/g, ' '));
    if (!name) continue;
    const key = 'n:' + name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); items.push({ type: 'name', slug: null, name, input: name }); }
  }
  return items;
}

// ------------------------------------------------------- Bing SERP utils ----

/**
 * Bing wraps organic links in /ck/a redirect URLs like:
 *   https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9saW5rZWRpbi5jb20vaW4v...
 * Decode the `u` parameter (strip leading "a1", base64url decode).
 */
export function decodeBingUrl(href) {
  if (!href) return '';
  try {
    if (/bing\.com\/ck\/a/i.test(href)) {
      const m = String(href).match(/[?&]u=a1([A-Za-z0-9\-_]+)/);
      if (m) {
        let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const dec = atob(b64);
        if (/^https?:\/\//i.test(dec)) return dec;
      }
    }
  } catch (e) { /* fall through */ }
  return href;
}

const JUNK_TITLE_RE = /(on linkedin[:\s]|#?\d[\d,]*\s+followers?|[\d,]+\s+connections?|linkedin: (log in|sign up)|explore|jobs on linkedin)/i;

// Title keywords that identify the DESIGNATION segment (v1.1: a segment
// without any keyword is treated as company/affiliation — NOT as designation).
const DESIG_KW_RE = /(ceo|cto|cio|cdo|coo|cfo|ciso|cpo|chief|founder|co-?founder|president|owner|managing director|vp|vice president|director|head of|general manager|partner|principal|country manager|zonal|regional|innovation|transformation|architect|engineering|developer|scientist|research|technology|product|data)/i;

// Strict leading-title pattern for single-segment titles: "Jane Doe CEO at Acme"
const LEADING_TITLE_RE = /^(.+?)\s+((?:co-?founder|founder|ceo|cto|cio|cdo|coo|cfo|ciso|cpo|president|owner|chief|managing director|vp|vice president|director|head of|general manager)\b.*)$/i;

/**
 * Parse a Bing result title like:
 *   "Jane Doe - Chief Technology Officer - Acme Corp | LinkedIn"
 *   "John Smith - Founder & CEO at Acme | LinkedIn"
 *   "Jane Doe CEO at Acme | LinkedIn"  (single segment)
 * into { name, designation } — designation may be '' when the SERP title
 * shows only an affiliation. Returns null for junk rows.
 */
export function parseProfileTitle(rawTitle) {
  if (!rawTitle) return null;
  let t = rawTitle.replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
  t = t.replace(/\s*[-–—|]\s*(LinkedIn\s*(India|UK|US)?)\s*$/i, '').trim();
  if (JUNK_TITLE_RE.test(t)) return null;
  // Split on common separators, keep 2-4 segments
  let parts = t.split(/\s+[-–—]\s+|\s*\|\s*|\s+[•·]\s+/).map(s => s.trim()).filter(Boolean);
  // Single-segment fallback: "Jane Doe CEO at Acme"
  if (parts.length === 1 && LEADING_TITLE_RE.test(parts[0])) {
    const m = parts[0].match(LEADING_TITLE_RE);
    if (m) parts = [m[1], m[2]];
  }
  if (parts.length < 2) return null;
  // Name = first short, name-like segment
  const nameCandidate = parts[0].replace(/\(.*?\)/g, '').replace(/[\d,]+.*$/, '').trim();
  if (!nameCandidate || nameCandidate.length < 3 || nameCandidate.split(/\s+/).length > 6) return null;
  if (!/[A-Za-z]/.test(nameCandidate)) return null;
  // Designation = the segment with a title keyword (longest such segment).
  // v1.0 bug: fell back to parts[1] — putting the COMPANY NAME into the
  // designation column. Now a keyword-less segment yields designation ''.
  let designation = '';
  for (let i = 1; i < parts.length; i++) {
    if (DESIG_KW_RE.test(parts[i])) {
      if (parts[i].length > designation.length) designation = parts[i];
    }
  }
  designation = designation
    .replace(/\s+at\s+.*$/i, '')           // strip " at Company"
    .replace(/\s*@\s*.*$/, '')             // strip " @Company"
    .replace(/\s*\|.*$/, '')
    .replace(/^[,\-–—\s]+|[,\-–—\s]+$/g, '')
    .trim();
  return { name: nameCandidate, designation: designation.slice(0, 120) };
}

/**
 * Pull a company-size phrase out of SERP titles/snippets:
 *   "5,001-10,000 employees" / "201 to 500 employees" / "over 200 employees"
 * Returns null when absent. (RC5: LinkedIn pages are frequently authwalled —
 * Bing snippets of company pages carry the size, so we recover it there.)
 */
export function extractSizeFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/(\d[\d,]{0,9})\s*(?:[-\u2013\u2014]|to)\s*(\d[\d,]{0,9})\s*employees/i);
  if (m) return m[1] + '-' + m[2] + ' employees';
  m = s.match(/\b(\d[\d,]{0,9})\s*employees\b/i);
  if (m) return m[1] + ' employees';
  return null;
}

export function linkedinHandle(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^\/\?&#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function isLinkedInProfile(url) {
  return /linkedin\.com\/in\//i.test(url || '');
}

/**
 * Does `text` plausibly refer to `companyName`?
 * Token-based: every significant token of the company name appears in the text
 * (ignore case, common legal/geo filler words). Single-word companies must match fully.
 */
const FILLER = new Set(['inc', 'llc', 'ltd', 'limited', 'gmbh', 'pte', 'co', 'corp', 'corporation',
  'company', 'group', 'holdings', 'the', 'and', 'of', 'india', 'usa', 'us', 'uk', 'bv', 'ag', 'sa',
  // common legal/brand suffixes (esp. Indian corporate names) that LinkedIn
  // titles usually drop: "Nuclearis Technologies" → page "Nuclearis"
  'pvt', 'private', 'technologies', 'technology', 'solutions', 'systems', 'labs',
  'ventures', 'enterprises', 'industries', 'consulting', 'telecom', 'software',
  'international', 'global', 'worldwide', 'trading', 'associates', 'projects']);

export function companyMatch(text, companyName) {
  if (!text || !companyName) return false;
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const tokens = companyName.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/)
    .map(t => t.replace(/&/g, '')).filter(t => t.length >= 2 && !FILLER.has(t));
  if (!tokens.length) return false;
  return tokens.every(t => hay.includes(' ' + t + ' '));
}

/**
 * Recall-friendly variant used ONLY as a fallback: when a plain company name
 * could not be resolved to a LinkedIn page, the typed legal name ("Zoho
 * Corporation") won't appear on profiles that just say "at Zoho" — strict
 * all-token matching rejects everyone. Partial match needs ONE significant
 * token (≥3 chars) and is applied only to company-scoped search results.
 */
export function companyMatchPartial(text, companyName) {
  if (!text || !companyName) return false;
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const tokens = companyName.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/)
    .map(t => t.replace(/&/g, '')).filter(t => t.length >= 3 && !FILLER.has(t));
  if (!tokens.length) return false;
  return tokens.some(t => hay.includes(' ' + t + ' '));
}

// ------------------------------------------------- name-mode resolution ----

/** How many tokens of textA appear in textB as whole words (≥2 chars). */
export function overlapTokens(textA, textB) {
  const ta = String(textA || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  const tb = ' ' + String(textB || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ') + ' ';
  let n = 0;
  for (const t of ta) {
    if (tb.indexOf(' ' + t + ' ') !== -1) n++;
  }
  return n;
}

/** "Tata Consultancy Services" → "tata-consultancy-services" (LinkedIn slug shape). */
export function kebabName(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Precision helper: token overlap between a LinkedIn slug and the typed name. */
export function slugScore(slug, name) {
  const sTokens = String(slug || '').toLowerCase().split(/[-_]+/).filter(t => t.length >= 2);
  const nTokens = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  let score = 0;
  for (const st of sTokens) {
    if (nTokens.indexOf(st) !== -1) score += 3;
  }
  return score;
}

/**
 * Tier-2 resolver gate: recall-friendly matching for Bing company-page results.
 * Returns a confidence tier (2 strong / 1 weak / 0 reject). The strict
 * all-token gate rejected correct pages whose LinkedIn title is shorter than
 * the typed legal name ("Zoho" for "Zoho Corporation").
 */
export function looseResolveMatch(title, snippet, slug, name) {
  const low = (String(title || '') + ' ' + String(snippet || '')).toLowerCase();
  const nTokens = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  if (!nTokens.length) return 0;
  // strong: the full typed name appears in the result text
  if (low.indexOf(String(name).toLowerCase()) !== -1) return 2;
  // strong: every significant token present in title/snippet
  if (nTokens.every(t => low.indexOf(t) !== -1)) return 2;
  // medium: the slug alone covers every significant query token
  const sTokens = String(slug || '').toLowerCase().split(/[-_]+/).filter(t => t.length >= 2);
  const slugJoined = ' ' + sTokens.join(' ') + ' ';
  if (nTokens.every(t => slugJoined.indexOf(' ' + t + ' ') !== -1)) return 2;
  // weak: token overlap on both slug and text (scoring picks the best candidate)
  const slugHit = nTokens.some(t => slugJoined.indexOf(' ' + t + ' ') !== -1);
  const textHit = nTokens.some(t => low.indexOf(t) !== -1);
  if (slugHit && textHit) return 1;
  return 0;
}

// ---------------------------------------------------- role currency (v1.3) ----
// The user wants the CURRENT designation at THIS company — not a past one.
// Bing titles carry the profile's indexed headline (usually the current role);
// snippets can mention old roles. So:
//   company in TITLE           → current role, title-verified
//   company only in SNIPPET    → weaker; if the snippet also carries a
//                                past-role marker ("former", "ex-", "previously",
//                                "was CEO") the person is DROPPED
//   company in BOTH + marker   → contradictory evidence → flagged for review
// Exported for unit tests; used by background.peopleFromSerp.

export const ROLE_PAST_RE = /\b(?:former|past|previously)\b|\bex\s?[-\s]?\s?(?:ceo|cto|cio|coo|cfo|ciso|cpo|chief|founder|co-?founder|director|head|vp|vice|president|owner|partner|manager|employee)\b|\bwas\s+(?:a|an|the)?\s*(?:ceo|cto|cio|coo|cfo|ciso|cpo|chief|founder|co-?founder|director|head|vp|vice president|president|owner|partner|manager)\b/i;

// Index of the first significant company token inside a NORMALIZED snippet.
function firstCompanyTokenIndex(normSnippet, companyName) {
  const tokens = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s&]/g, ' ')
    .split(/\s+/).map(t => t.replace(/&/g, '')).filter(t => t.length >= 3 && !FILLER.has(t));
  let best = -1;
  for (const t of tokens) {
    const idx = normSnippet.indexOf(' ' + t + ' ');
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/**
 * Snippet-only currency: a past-role marker is only fatal when it appears
 * BEFORE the company mention ("Former CEO at Acme", "was CTO of Acme").
 * "Acme Corp engineer, previously at Google" names the company first — the
 * marker refers to an older job elsewhere → the role is current here.
 */
function snippetCurrency(snippetHay, companyName) {
  // padded — company tokens are matched with leading/trailing spaces
  const norm = ' ' + String(snippetHay || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (!ROLE_PAST_RE.test(norm)) return 'snippet';
  const m = norm.match(ROLE_PAST_RE);
  const markerIdx = m ? m.index : norm.length;
  const companyIdx = firstCompanyTokenIndex(norm, companyName);
  if (companyIdx !== -1 && companyIdx < markerIdx) return 'snippet';
  // "Previously at Google, now CTO at Acme" — a now/current transition before
  // the company mention means the role that follows is the current one.
  const nowMatch = norm.match(/ (?:now|currently|presently|joined) /);
  const nowIdx = nowMatch ? nowMatch.index : -1;
  if (companyIdx !== -1 && nowIdx !== -1 && companyIdx > nowIdx) return 'snippet';
  return 'past';
}

export function roleCurrency(inTitle, inSnippet, titleHay, snippetHay, companyName) {
  if (inTitle) {
    if (inSnippet && ROLE_PAST_RE.test(snippetHay || '')) return 'review-past';
    return 'current';
  }
  if (inSnippet) {
    return snippetCurrency(snippetHay, companyName);
  }
  return 'past';
}

/**
 * Corpus grounding for AI-proposed people (v1.4.1 anti-hallucination gate).
 * A person is only evidence-backed when their full name appears in a
 * company-scoped search result AND that result ties them to this company with
 * a non-past role. Returns {index, role} for the strongest match, else null.
 * The model's own "current" claim is never used as evidence.
 */
export function nameEvidence(name, serp, companyName) {
  const raw = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const significant = raw.filter(t => t.length >= 2);
  // One-token names cannot be grounded safely ("Smith" matches any Smith).
  if (significant.length < 2) return null;
  const phrase = ' ' + raw.join(' ') + ' ';
  const rank = { current: 3, snippet: 2, 'review-past': 1 };
  let best = null;
  const list = Array.isArray(serp) ? serp : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const title = String(r.title || '');
    const snippet = String(r.snippet || '');
    const hay = ' ' + (title + ' ' + snippet).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim() + ' ';
    if (hay.indexOf(phrase) === -1) continue;
    const role = roleCurrency(companyMatch(title, companyName), companyMatch(snippet, companyName),
      title, snippet, companyName);
    if (role === 'past') continue;
    const score = rank[role] || 0;
    if (!best || score > best.score) best = { index: i, role, score };
  }
  return best ? { index: best.index, role: best.role } : null;
}

export const ROLE_LABELS = {
  'current': 'Current',
  'snippet': 'Current (snippet)',
  'official': 'Current (official company source)',
  'review-past': 'Review — possibly past'
};

// ------------------------------------------------- Hunter.io email matching ----

function cleanNamePart(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Match a person against emails found by Hunter.io for the company domain.
 * @param {string} fullName
 * @param {Array} hunterEmails  [{value, first_name, last_name, position}]
 * @param {string|null} patternTemplate  Hunter's verified domain pattern, e.g. "{first}.{last}"
 * @param {string|null} domain           corporate domain for the pattern fallback
 * @returns {{email:string, status:string}|null}
 */
export function matchHunterEmail(fullName, hunterEmails, patternTemplate, domain) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(p => /[A-Za-z]/.test(p));
  if (!parts.length) return null;
  const first = cleanNamePart(parts[0]);
  const last = cleanNamePart(parts[parts.length - 1]);
  for (const e of (hunterEmails || [])) {
    if (!e || !e.value) continue;
    const hf = cleanNamePart(e.first_name);
    const hl = cleanNamePart(e.last_name);
    if (hf && hl && hf === first && hl === last) {
      return { email: e.value, status: 'verified via Hunter.io' };
    }
    const local = String(e.value).split('@')[0].toLowerCase();
    if (!local) continue;
    if (first && last && (
      local === first + '.' + last || local === first[0] + last ||
      local === first + last || local === first + '.' + last.charAt(0))) {
      return { email: e.value, status: 'matched via Hunter.io' };
    }
  }
  if (patternTemplate && domain) {
    const local = String(patternTemplate)
      .replace(/\{first_initial\}/gi, first ? first.charAt(0) : '')
      .replace(/\{last_initial\}/gi, last ? last.charAt(0) : '')
      .replace(/\{f\}/gi, first ? first.charAt(0) : '')
      .replace(/\{l\}/gi, last ? last.charAt(0) : '')
      .replace(/\{first\}/gi, first)
      .replace(/\{last\}/gi, last)
      .replace(/[^a-z0-9._\-]/gi, '');
    // accept any resolved local part with at least one letter — Hunter
    // patterns like "{first}{last}" contain no dot but are still verified
    if (local && /[a-z]/i.test(local)) {
      return { email: local + '@' + domain, status: 'pattern from Hunter.io (domain-verified)' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- emails ----

export function domainFromWebsite(website) {
  if (!website) return null;
  const m = String(website).trim().match(/^(?:https?:\/\/)?(?:[^@\/\s]+@)?([a-z0-9\-\.]+\.[a-z]{2,})/i);
  if (!m) return null;
  let host = m[1].toLowerCase().replace(/^www\./, '');
  if (/^(gmail|yahoo|hotmail|outlook|icloud|proton|rediffmail)\./.test(host)) return null; // not a corporate domain
  return host;
}

// Directory/social/search hosts are not the company's own website.
const NON_COMPANY_HOSTS = [
  'bing.com', 'linkedin.com', 'wikipedia.org', 'glassdoor.com', 'glassdoor.co.in',
  'crunchbase.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com',
  'instagram.com', 'indeed.com', 'g2.com', 'trustpilot.com', 'bloomberg.com',
  'reuters.com', 'forbes.com', 'techcrunch.com', 'medium.com', 'reddit.com',
  'quora.com', 'pitchbook.com', 'zoominfo.com', 'apollo.io', 'signalhire.com',
  'lusha.com', 'rocketreach.co', 'similarweb.com', 'owler.com'
];
const BAD_SUBDOMAINS = new Set(['login', 'signin', 'support', 'help', 'jobs', 'careers',
  'ir', 'investor', 'investors', 'blog', 'news', 'press', 'store', 'shop', 'docs',
  'developer', 'developers', 'api', 'status', 'trust', 'security', 'accounts', 'auth']);

/**
 * Infer a company's own website from its company-name search results. This is
 * a candidate only: official-source rows still have to pass a domain check and
 * a current-role/company-scope check. It exists because LinkedIn company pages
 * are often walled while the company homepage is still public.
 */
export function inferWebsiteFromSerp(serp, companyName) {
  const rawTokens = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  const nameTokens = rawTokens.filter(t => !FILLER.has(t));
  if (!nameTokens.length) return null;
  let best = null;
  const list = Array.isArray(serp) ? serp : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    let u;
    try { u = new URL(String(r.url || '')); } catch (e) { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) continue;
    if (NON_COMPANY_HOSTS.some(suffix => host === suffix || host.endsWith('.' + suffix))) continue;
    if (BAD_SUBDOMAINS.has(host.split('.')[0])) continue;
    const title = String(r.title || '');
    const snippet = String(r.snippet || '');
    const hay = ' ' + (title + ' ' + snippet).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ') + ' ';
    const hostParts = host.split('.')[0].split(/[^a-z0-9]+/).filter(Boolean);
    const hostCompact = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const titleMatch = nameTokens.every(t => hay.includes(' ' + t + ' '));
    const matched = rawTokens.filter(t => hostCompact.includes(t)).length;
    const singleHost = matched === 1 && rawTokens[0] &&
      (hostCompact === rawTokens[0] ||
        (hostCompact.startsWith(rawTokens[0]) &&
          ['group', 'world', 'global', 'india', 'corp'].includes(hostCompact.slice(rawTokens[0].length))));
    const hostMatch = rawTokens.length === 1 ? singleHost : matched >= Math.min(2, rawTokens.length);
    if (!hostMatch) {
      const extra = hostParts.filter(part => !rawTokens.includes(part) && !FILLER.has(part));
      if (!titleMatch || extra.length) continue;
    }
    const score = matched * 3 + (titleMatch ? 2 : 0) + (hostMatch ? 2 : 0) + (i === 0 ? 1 : 0);
    if (!best || score > best.score) best = { url: 'https://' + host + '/', host, score, title };
  }
  return best;
}

const SITE_SUFFIX = new Set(['limited', 'ltd', 'inc', 'corp', 'corporation', 'pvt', 'private',
  'group', 'groups', 'world', 'global', 'holdings', 'holding', 'plc', 'llp', 'company', 'co']);

/** Does a website domain plausibly belong to this company? */
export function domainMatchesCompany(domain, companyName) {
  const compact = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
  const raw = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  const core = raw.filter(t => !SITE_SUFFIX.has(t));
  const tokens = core.length ? core : raw;
  if (!compact || !tokens.length) return false;
  const hits = tokens.filter(t => compact.includes(t)).length;
  if (tokens.length === 1) {
    if (compact === tokens[0]) return true;
    if (!compact.startsWith(tokens[0])) return false;
    return ['group', 'world', 'global', 'india', 'corp'].includes(compact.slice(tokens[0].length));
  }
  return hits >= 2;
}

/** Deterministic candidate homepages for companies whose website was not found. */
export function websiteCandidates(companyName) {
  const raw = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
  if (!raw.length) return [];
  const values = [];
  const add = (parts) => { const v = parts.join(''); if (v.length >= 3) values.push(v); };
  add(raw);
  for (let i = raw.length - 1; i >= 1; i--) add(raw.slice(0, i));
  const core = raw.filter(t => !SITE_SUFFIX.has(t));
  if (core.length && core.length !== raw.length) add(core);
  const base = (core.length ? core : raw).join('');
  for (const suffix of ['group', 'world', 'global', 'india']) add([base, suffix]);
  return [...new Set(values)].slice(0, 10).map(v => 'https://' + v + '.com/');
}

const COUNTRY_NAMES = {
  IN: 'India', US: 'United States', USA: 'United States', GB: 'United Kingdom', UK: 'United Kingdom',
  AE: 'United Arab Emirates', SG: 'Singapore', DE: 'Germany', FR: 'France', JP: 'Japan',
  CN: 'China', CA: 'Canada', AU: 'Australia', BR: 'Brazil', MX: 'Mexico', NL: 'Netherlands',
  CH: 'Switzerland', IL: 'Israel', IE: 'Ireland', PL: 'Poland'
};
const COUNTRY_IN_TEXT = /\b(India|United States|USA|United Kingdom|UAE|United Arab Emirates|Singapore|Germany|France|Japan|China|Canada|Australia|Brazil|Mexico|Netherlands|Switzerland|Israel|Ireland|Poland)\b/i;
// Trailing fragments that mean the address was cut off mid-line ("… Inspire, Off").
const ADDRESS_TAIL = /^(?:off|near|opp|opposite|behind|above|below|plot|floor|road|rd|street|st|lane|phase|unit|block|sector|village|taluka|district)$/i;
function trimAddressTail(hq) {
  const parts = String(hq || '').split(',').map(s => s.trim()).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last.length >= 3 && !ADDRESS_TAIL.test(last)) break;
    parts.pop();
  }
  return parts.join(', ');
}
const INDUSTRY_HINTS = [
  [/pharma|pharmaceutical|drug/, 'Pharmaceuticals'],
  [/information technology|it services|technology solution|digital transformation/, 'IT Services'],
  [/oil|gas|petroleum|refin|fuel/, 'Oil & Gas'],
  [/renewable|solar|wind power/, 'Renewable Energy'],
  [/home textile|textile|fabric|yarn/, 'Textiles'],
  [/chemical/, 'Chemicals'],
  [/holding company|conglomerate/, 'Holding Companies'],
  [/software|saas|cloud platform/, 'Software'],
  [/bank|financial services|insurance/, 'Financial Services'],
  [/automotive|auto component/, 'Automotive'],
  [/consumer goods|fmcg/, 'Consumer Goods'],
  [/real estate|properties/, 'Real Estate'],
  [/telecom/, 'Telecommunications']
];

/**
 * Extract company facts from a company-owned page payload. Pure so the
 * "official site" fallback is testable without a browser.
 */
export function companyFactsFromPage(page) {
  const out = { employees: '', industry: '', hq: '', country: '', linkedinUrl: '' };
  const p = page || {};
  const title = cell(p.title || '');
  const description = cell(p.description || '');
  const text = cell(p.text || '').slice(0, 20000);
  const org = p.structured && typeof p.structured === 'object' ? p.structured : {};
  const shortHay = (title + ' ' + description).toLowerCase();
  const hay = (shortHay + ' ' + text).toLowerCase();
  const fmtNum = (value) => {
    const n = Number(String(value || '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-US') : String(value || '');
  };

  const liMatch = String(p.linkedinUrl || '').match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (liMatch) out.linkedinUrl = 'https://www.linkedin.com/company/' + liMatch[1].toLowerCase() + '/';
  if (!out.linkedinUrl && Array.isArray(org.sameAs)) {
    for (const item of org.sameAs) {
      const m = String(item || '').match(/linkedin\.com\/company\/([^/?#]+)/i);
      if (m) { out.linkedinUrl = 'https://www.linkedin.com/company/' + m[1].toLowerCase() + '/'; break; }
    }
  }

  const emp = org.numberOfEmployees;
  if (typeof emp === 'number' && emp > 0) {
    out.employees = Math.round(emp).toLocaleString('en-US') + ' employees';
  } else if (emp && typeof emp === 'object') {
    const min = Number(emp.value != null ? emp.value : emp.minValue);
    const max = Number(emp.maxValue);
    if (min > 0 && max > min) out.employees = min.toLocaleString('en-US') + '–' + max.toLocaleString('en-US') + ' employees';
    else if (min > 0) out.employees = min.toLocaleString('en-US') + '+ employees';
  }
  if (!out.employees && text) {
    let m = text.match(/(\d[\d,]{1,})\s*(?:-|–|to)\s*(\d[\d,]{1,})\s*(?:employees|people|workforce|team members)/i);
    if (m) out.employees = fmtNum(m[1]) + '–' + fmtNum(m[2]) + ' employees';
    else {
      // Reproduce the strength the source printed: "over 5,000" and "5,000+"
      // both mean 5,000+, but "about 500" / "500" must stay plain.
      m = text.match(/(?:(over|more than|about|approximately)\s+)?(\d[\d,]{1,})\s*(\+?)\s*(?:employees|people|workforce|team members)/i);
      if (m) {
        const stronger = m[3] || /^over$|^more than$/i.test(m[1] || '');
        out.employees = fmtNum(m[2]) + (stronger ? '+ employees' : ' employees');
      }
    }
  }

  const orgIndustry = cell(org.industry || '');
  if (orgIndustry) out.industry = orgIndustry.slice(0, 80);
  else {
    const hint = INDUSTRY_HINTS.find(([re]) => re.test(shortHay)) || INDUSTRY_HINTS.find(([re]) => re.test(hay));
    if (hint) out.industry = hint[1];
  }

  const addr = org.address;
  if (addr && typeof addr === 'object') {
    const countryName = COUNTRY_NAMES[String(addr.addressCountry || '').toUpperCase()] || cell(addr.addressCountry);
    const parts = [addr.addressLocality, addr.addressRegion, countryName].map(cell).filter(Boolean);
    if (parts.length) out.hq = [...new Set(parts)].join(', ');
    out.country = countryName;
  } else if (typeof addr === 'string') {
    out.hq = cell(addr);
  }
  if (!out.hq) {
    const m = text.match(/(?:headquartered in|head office(?: is)?(?: in| at|:)?|registered office(?: is)?(?: in| at|:)?|corporate office(?: is)?(?: in| at|:)?|address(?: is|:)?|regd\.? office(?: is|:)?)\s+([^.;]{3,160})/i);
    if (m) {
      let hq = m[1].replace(/\b(?:19|20)\d{2}\b.*$/, '').trim();
      // Prose addresses run on into the next sentence, a timeline, or a street
      // fragment. Cut at the country it names when there is one.
      const cm = hq.match(COUNTRY_IN_TEXT);
      if (cm) hq = hq.slice(0, cm.index + cm[0].length);
      if (/acquisition|journey|read more|established|the company/i.test(hq)) hq = '';
      else if (!cm && hq.length > 70) hq = '';
      hq = trimAddressTail(hq);
      // "Registered office: Acme Industries Ltd" is a legal name, not an address.
      if (!cm && !/,/.test(hq) && /\b(?:ltd|limited|inc|plc|llp|corp|corporation|gmbh|pte)\b\.?$/i.test(hq)) hq = '';
      out.hq = hq.replace(/[,:;\s]+$/, '');
    }
  }
  if (!out.country) {
    const m = out.hq.match(COUNTRY_IN_TEXT);
    if (m) out.country = COUNTRY_NAMES[m[1].toUpperCase()] || m[1];
  }
  return out;
}
// ------------------------------------------------ official-source recovery ----
// Bing does not consistently index LinkedIn profile pages. When a company
// website is known, an official leadership / newsroom result is a useful,
// evidence-backed fallback. These helpers deliberately require that source
// domain and never manufacture a LinkedIn URL.

const LEADERSHIP_WORD_RE = /\b(?:chief\s+(?:[a-z&]+\s+){0,3}officer|ceo|cto|cio|cdo|cpo|coo|cfo|ciso|caio|cmo|chair(?:man|person)?|managing director|president|co-?founder|founder|vice president|vp|head of|director)\b/i;
const NAME_STOP_WORDS = new Set([
  'leadership', 'management', 'executive', 'team', 'company', 'board', 'group',
  'chief', 'officer', 'director', 'president', 'founder', 'vice', 'head', 'about',
  'news', 'contact', 'careers', 'investors', 'investor', 'relations', 'linkedin',
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'plc', 'gmbh', 'pvt', 'holdings'
]);

function officialSourceDomainMatches(url, domain) {
  if (!url || !domain) return false;
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const base = String(domain).toLowerCase().replace(/^www\./, '');
    return host === base || host.endsWith('.' + base);
  } catch (e) {
    return false;
  }
}

function hasOfficialCompanyScope(evidence, companyName) {
  const hay = ' ' + String(evidence || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const scopeFiller = new Set(['inc', 'llc', 'ltd', 'limited', 'pvt', 'private', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of', 'group', 'groups', 'holding', 'holdings', 'technology', 'technologies', 'solutions']);
  const tokens = String(companyName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(token => token.length >= 2 && !scopeFiller.has(token));
  return !!tokens.length && tokens.every(token => hay.includes(' ' + token + ' '));
}

function isDurableLeadershipSource(url, evidence) {
  let path = '';
  try { path = new URL(String(url)).pathname.toLowerCase(); } catch (e) { return false; }
  const text = String(evidence || '').toLowerCase();
  // Current leadership / governance pages are durable evidence. A same-domain
  // newsroom article or old appointment is not enough to claim a role today.
  const durablePath = /(?:^|\/)(?:leadership|leaders|management|executive(?:-team)?|team|people|governance|board|about|our-people)(?:\/|$)/.test(path);
  const durableText = /\b(?:leadership|leaders|our leadership|who leads|leadership team|executive team|management team|board of directors|our people|company leadership)\b/.test(text);
  if (!durablePath && !durableText) return false;
  if (/(?:^|\/)(?:news(?:room)?|press(?:-releases?)?|media(?:-center)?|blog|archive|article|articles|events)(?:\/|$)/.test(path)) return false;
  if (/\b(?:appointed|announced|joins?|named|effective from)\b/.test(text) && /\b(?:19|20)\d{2}\b/.test(text)) return false;
  return true;
}

function cleanLeaderName(raw) {
  const name = cell(raw)
    .replace(/^(?:dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6 || name.length > 100) return '';
  if (words.some(word => NAME_STOP_WORDS.has(word.replace(/[^A-Za-z]/g, '').toLowerCase()))) return '';
  // Require name-like tokens while allowing initials, accents, apostrophes,
  // hyphens and lowercase name particles ("van", "de", "bin").
  const particles = new Set(['van', 'von', 'der', 'de', 'da', 'di', 'du', 'la', 'le', 'bin', 'al', 'el', 'del', 'della', 'st']);
  if (words.some(word => !particles.has(word.toLowerCase()) &&
      !/^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’-]*$/u.test(word))) return '';
  return name;
}

function cleanLeadershipRole(raw) {
  let role = cell(raw)
    .split(/\s+(?:at|@)\s+/i)[0]
    .split(/\s+[-–—|]\s+/)[0]
    .replace(/^(?:the\s+)/i, '')
    .trim();
  if (!LEADERSHIP_WORD_RE.test(role)) return '';
  // Avoid accepting an arbitrary sentence after the title from a search snippet.
  role = role.replace(/[.;].*$/, '').trim();
  return role.slice(0, 120);
}

function leadershipPairFromText(raw) {
  const text = cell(raw).slice(0, 500);
  if (!text || !LEADERSHIP_WORD_RE.test(text)) return null;

  // Common SERP title: "Asha Shah - Chief Technology Officer - Example".
  let m = text.match(/^(.{3,110}?)\s+[-–—|]\s+(.{3,180})$/);
  if (m) {
    const name = cleanLeaderName(m[1]);
    const designation = cleanLeadershipRole(m[2]);
    if (name && designation) return { name, designation };
  }
  // Common article snippet: "Asha Shah, Chief Technology Officer, ...".
  m = text.match(/^(.{3,110}?),\s+(?:the\s+)?(.{3,180})$/);
  if (m) {
    const name = cleanLeaderName(m[1]);
    const designation = cleanLeadershipRole(m[2]);
    if (name && designation) return { name, designation };
  }
  // Statement form: "Asha Shah is the Chief Technology Officer ...".
  m = text.match(/^(.{3,110}?)\s+(?:is|serves as|has been appointed as)\s+(?:the\s+)?(.{3,180})$/i);
  if (m) {
    const name = cleanLeaderName(m[1]);
    const designation = cleanLeadershipRole(m[2]);
    if (name && designation) return { name, designation };
  }
  // Inverted headline: "Chief Technology Officer: Asha Shah".
  m = text.match(/^(.{3,180}?)\s*[:–—-]\s*(.{3,110})$/);
  if (m) {
    const designation = cleanLeadershipRole(m[1]);
    const name = cleanLeaderName(m[2]);
    if (name && designation) return { name, designation };
  }
  return null;
}

/**
 * Convert a company-owned search result into a current leadership candidate.
 * A candidate is accepted only when the URL is on the known corporate domain,
 * the result itself contains a name + senior role, and it carries no past-role
 * wording. The returned record intentionally has no LinkedIn URL.
 */
export function officialLeadershipCandidate(result, website, companyName) {
  const domain = domainFromWebsite(website);
  const url = String(result && result.url || '');
  if (!domain || !officialSourceDomainMatches(url, domain)) return null;
  const title = cell(result && result.title || '');
  const snippet = cell(result && result.snippet || '');
  const evidence = (title + ' ' + snippet).trim();
  if (!evidence || ROLE_PAST_RE.test(evidence)) return null;
  if (!hasOfficialCompanyScope(evidence, companyName)) return null;
  if (!isDurableLeadershipSource(url, evidence)) return null;
  const pair = leadershipPairFromText(title) || leadershipPairFromText(snippet);
  if (!pair) return null;
  // Board pages often list external members with their role at another
  // company. Keep those only when the stated role is at this company.
  if (/board of directors|governance/i.test(evidence) &&
      !hasOfficialCompanyScope(pair.designation, companyName)) return null;
  return {
    ...pair,
    evidenceUrl: url,
    evidenceText: evidence.slice(0, 500),
    sourceType: 'official'
  };
}

/**
 * Validate a person extracted directly from a company-owned leadership page.
 * The domain must match the known company website; board members whose listed
 * role belongs to another company are rejected; no LinkedIn URL is created.
 */
export function officialPageCandidate(candidate, website, companyName) {
  const domain = domainFromWebsite(website);
  if (!domain) return null;
  const url = String(candidate && candidate.url || '');
  if (!officialSourceDomainMatches(url, domain)) return null;
  const name = cleanLeaderName(candidate && candidate.name);
  const designation = cleanLeadershipRole(candidate && candidate.role);
  if (!name || !designation) return null;
  if (ROLE_PAST_RE.test(designation)) return null;
  const pageTitle = cell(candidate && candidate.pageTitle || '');
  const section = cell(candidate && candidate.section || '');
  const context = cell(candidate && candidate.evidence || '').slice(0, 500);
  const roleHasCompany = hasOfficialCompanyScope(designation + ' ' + context, companyName);
  const pageScope = hasOfficialCompanyScope(pageTitle + ' ' + designation, companyName);
  const domainTrust = domainMatchesCompany(domain, companyName);
  const leadershipContext = /(?:leadership|leaders|management|executive|board|governance|who leads|our people)/i
    .test(pageTitle + ' ' + section + ' ' + designation + ' ' + context);
  // Board cards often list an external person's role at another company. Keep
  // them only when the stated role itself is at the target company.
  const boardSection = /board|governance|directors?/i.test(section);
  const boardRole = /\b(?:chair(?:man|person|woman)?|managing director|executive director|non-executive director|independent director|director|board member)\b/i.test(designation);
  if (boardSection && !hasOfficialCompanyScope(designation, companyName) && !boardRole) return null;
  // A verified company domain plus a leadership page is enough when the page
  // title uses a legal variant (e.g. "Sun Pharmaceutical" for "SUN PHARMA").
  if (!pageScope && !roleHasCompany && !(domainTrust && leadershipContext)) return null;
  if (!isDurableLeadershipSource(url, pageTitle + ' ' + section + ' ' + designation + ' ' + context)) return null;
  // A profile link found on the company's own page is real evidence, but it is
  // not a verified profile: keep the URL, never the "verified" claim.
  const profileUrl = linkedinUrlForExport(candidate && candidate.profileUrl);
  return {
    name, designation,
    evidenceUrl: url,
    evidenceText: (name + ' — ' + designation + ' — ' + (pageTitle || section)).slice(0, 500),
    profileUrl,
    sourceType: 'official'
  };
}

/**
 * Country from the company's own search results, used only when no page states
 * an address. Requires the same country in at least two snippets that name the
 * company, so a passing "expands to the US" mention cannot relabel a company.
 */
export function countryFromSerp(serp, companyName) {
  const list = Array.isArray(serp) ? serp : [];
  if (!list.length) return '';
  const tokens = String(companyName || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2);
  const counts = new Map();
  for (const r of list) {
    const hay = String((r.title || '') + ' ' + (r.snippet || ''));
    if (!hay) continue;
    const named = !tokens.length || tokens.some(t => hay.toLowerCase().includes(t));
    if (!named) continue;
    for (const m of hay.matchAll(/\b(India|United States|USA|United Kingdom|UAE|United Arab Emirates|Singapore|Germany|France|Japan|China|Canada|Australia|Brazil|Mexico|Netherlands|Switzerland|Israel|Ireland|Poland)\b/gi)) {
      const key = m[1].replace(/^usa$/i, 'United States').replace(/^uae$/i, 'United Arab Emirates');
      const canon = key[0].toUpperCase() + key.slice(1);
      counts.set(canon, (counts.get(canon) || 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [name, n] of counts) {
    if (n > bestCount) { best = name; bestCount = n; }
  }
  return bestCount >= 2 ? best : '';
}

/**
 * Which people still need a profile lookup.  Ordered, capped, and never names
 * a person twice — so the caller's loop cost is predictable.
 */
export function resolveTargets(people, max = 6) {
  const cap = Math.max(0, Math.min(10, Number(max) || 0));
  const out = [];
  const seen = new Set();
  for (const person of (people || [])) {
    if (out.length >= cap) break;
    if (!person || person.url) continue;
    const name = cell(person.name) || cell([person.firstName, person.lastName].filter(Boolean).join(' '));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}

/**
 * Turn collected diagnostics into one honest outcome. Kept pure so every
 * branch (blocked, parse error, no profiles, rejected, source blocked) is
 * covered by deterministic tests.
 */
export function classifyOutcome(peopleCount, discovery) {
  const d = discovery || {};
  const states = d.sourceStates || {};
  const official = d.official || {};
  const rejected = Object.values(d.rejected || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const parts = [
    Number(d.queryCount || 0) + ' queries',
    Number(d.rawResultCount || 0) + ' readable results',
    Number(d.profileResultCount || 0) + ' profile results',
    rejected + ' rejected'
  ];
  if (official.used) {
    parts.push(Number(official.pages || 0) + ' company pages');
    parts.push(Number(official.candidates || 0) + ' official candidates');
    if (official.errors) parts.push(Number(official.errors) + ' company-page errors');
  }
  const query = (d.queries || []).slice(-1)[0];
  const detail = parts.join(' · ') + (query ? ' · last query: ' + String(query).slice(0, 160) : '');

  if (peopleCount > 0) return { outcome: 'people_found', reason: '', detail };
  if (states.captcha || states['bing-captcha'] || states.consent || states['bing-consent']) {
    return {
      outcome: 'search_blocked',
      reason: (states.captcha || states['bing-captcha'])
        ? 'Search blocked by Bing verification' : 'Bing consent is required',
      detail
    };
  }
  if (states['extractor-error'] || states['bing-extractor-error']) {
    return { outcome: 'search_error', reason: 'Search results could not be read', detail };
  }
  if (official.blocked) {
    return {
      outcome: 'source_blocked',
      reason: 'Company website blocked automated access',
      detail
    };
  }
  if (official.errors && !official.accepted) {
    return {
      outcome: 'source_error',
      reason: 'Company website pages could not be read',
      detail
    };
  }
  if (!d.profileResultCount) {
    return {
      outcome: 'no_profile_results',
      reason: official.used
        ? 'No matching LinkedIn profiles or explicit company leadership evidence was found'
        : 'No matching LinkedIn profiles were returned by Bing',
      detail
    };
  }
  if (!d.acceptedCount && rejected) {
    return {
      outcome: 'candidates_rejected',
      reason: 'Profile candidates did not pass company/current-role checks',
      detail
    };
  }
  return { outcome: 'no_public_match', reason: 'No evidence-backed decision-maker was found', detail };
}

function cleanEmailPart(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Pattern-estimate the corporate email. ALWAYS flagged "estimated — unverified".
 * Returns { email, status, alternates } or null when no domain.
 */
export function emailFor(fullName, domain) {
  if (!domain || !fullName) return null;
  const parts = fullName.trim().split(/\s+/).filter(p => /[A-Za-z]/.test(p));
  if (parts.length < 1) return null;
  const first = cleanEmailPart(parts[0]);
  const last = cleanEmailPart(parts[parts.length - 1]);
  if (!first || !last) return null;
  const f = first.charAt(0);
  const candidates = [`${first}.${last}`, `${f}${last}`, `${first}${last}`, `${first}`, `${first}_${last}`, `${f}.${last}`];
  return {
    email: `${candidates[0]}@${domain}`,
    status: 'estimated — unverified',
    alternates: candidates.slice(1).map(c => `${c}@${domain}`)
  };
}

// ------------------------------------------------------------- exports ----

export function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Normalize an exported spreadsheet cell without changing runtime source data. */
export function exportCell(v) {
  let s = cell(v);
  // Spreadsheet apps treat leading formula characters as executable input.
  // Prefix an apostrophe so a source/title pasted into an export stays text.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/**
 * The default export is deliberately a small, stable CRM contract.  Keep the
 * labels uppercase: downstream import mappings often match them literally.
 */
export const CRM_EXPORT_HEADERS = [
  'PROSPECT_FIRST_NAME',
  'PROSPECT_LAST_NAME',
  'DESIGNATION',
  'EMAIL_ID',
  'COMPANY_NAME',
  'COMPANY_SIZE',
  'COUNTRY',
  'INDUSTRY_TYPE',
  'WEBSITE_NAME',
  'LINKEDIN_URL'
];

/**
 * Split a display name without inventing information.  A CRM has no middle
 * name field, so every token after the first is retained in the last-name
 * cell; this preserves particles such as "de la", "van", and "von" rather
 * than dropping them.  Comma-ordered names are intentionally left blank
 * because their order is ambiguous without a source-specific parser.
 */
export function splitProspectName(name) {
  let value = cell(name);
  if (!value) return { firstName: '', lastName: '' };
  value = value
    .replace(/^(?:(?:dr|mr|mrs|ms|mx|prof)\.?\s+)+/i, '')
    .replace(/(?:,?\s+(?:jr|sr|ii|iii|iv|phd|md))\.?$/i, '')
    .trim();
  if (!value || /[,;|]/.test(value) || /\d/.test(value)) return { firstName: '', lastName: '' };
  const parts = value.split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** A CRM LinkedIn field must only ever contain a real person-profile URL. */
export function linkedinUrlForExport(value) {
  const url = cell(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return '';
    // A bare /in/ is a directory, not a person; require an actual profile slug.
    if (!/^\/(?:in|pub)\/[^/]{2,}\/?$/i.test(parsed.pathname)) return '';
    // Drop tracking parameters (?trk=…) so a CRM stays clean, and canonicalise
    // the host/path: in.linkedin.com and www.linkedin.com/in/Name/ are the same
    // person, and treating them as different created duplicate rows.
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase() + '/';
    return 'https://www.linkedin.com' + path;
  } catch (e) {
    return '';
  }
}

/** The public company domain is a portable CRM value; never infer one here. */
export function websiteNameForExport(website) {
  return domainFromWebsite(website) || '';
}

function priorityRank(person) {
  // `pri` is the number (1 = C-suite … 5 = managers). `priority` is only its
  // label, "P1", so it is used just as a fallback when the number is missing.
  return Number(person.pri) ||
    Number(String(person.priority || '').replace(/\D/g, '')) || 9;
}

/**
 * Order for one company's people, shared by the on-screen grid and the CSV so
 * the two can never disagree: most relevant first (priority, then score), with
 * the name as a final tie-break so the order is stable.
 */
export function sortPeople(comp) {
  return [...(comp.people || [])].sort((a, b) =>
    priorityRank(a) - priorityRank(b) ||
    (Number(b.score) || 0) - (Number(a.score) || 0) ||
    String(a.name || '').localeCompare(String(b.name || '')));
}

/**
 * The one rule for who is exported: a company's people in display order,
 * without anyone flagged as a possibly-past role. The on-screen grid and the
 * CSV both read from here, so a person is either in both or in neither.
 */
export function exportablePeople(comp) {
  return sortPeople(comp).filter(p => p.currentEmployer !== 'review-past');
}

export const NOT_FOUND = 'Not Found';

function crmPersonRow(p, comp, fillMissing = false) {
  const name = splitProspectName(p.name);
  const row = [
    name.firstName,
    name.lastName,
    p.designation || '',
    p.email || '',
    comp.name || comp.input || '',
    comp.size || '',
    comp.country || '',
    comp.industry || '',
    websiteNameForExport(comp.website),
    linkedinUrlForExport(p.url)
  ];
  // Opt-in placeholder only: a label, never data. The default stays blank so a
  // CRM import cannot mistake "Not Found" for a real value.
  return fillMissing ? row.map(v => (v === '' ? NOT_FOUND : v)) : row;
}

/**
 * One row model for the export, so a tab or newline inside a scraped value
 * can never shift a column.
 */
function exportRows(companies, { fillMissing = false } = {}) {
  const rows = [];
  const sorted = [...companies].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  for (const comp of sorted) {
    // Review diagnostics stay in the UI. Putting one in a CRM
    // prospect field would manufacture a lead that does not exist.
    for (const p of exportablePeople(comp)) rows.push(crmPersonRow(p, comp, fillMissing));
  }
  return rows;
}

/** How many prospect rows a given selection would actually export. */
export function exportRowCount(companies) {
  return exportRows(companies).length;
}

/** RFC-4180 quoting. Caller prepends the UTF-8 BOM on download. */
function csvCell(v) {
  // RFC 4180: quote when the value holds a delimiter, a quote or a line break.
  const s = exportCell(v).replace(/[\r\n\t]+/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * The only export format: the 10-column CRM contract as CSV, one row per
 * accepted current person. Exactly these columns, in this order, nothing else.
 * Unknown options are ignored, so no caller can widen the output.
 */
export function buildCSV(companies, { fillMissing = false } = {}) {
  return [CRM_EXPORT_HEADERS, ...exportRows(companies, { fillMissing })]
    .map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
// --------------------------------------------------------------- misc -----

export function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
