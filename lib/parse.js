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
  includeEmails: true,         // pattern-estimated emails, always flagged as unverified
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
  return {
    name, designation,
    evidenceUrl: url,
    evidenceText: (name + ' — ' + designation + ' — ' + (pageTitle || section)).slice(0, 500),
    sourceType: 'official'
  };
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

const CORE_HEAD = ['Name', 'Designation', 'Country', 'Company Name', 'Company Size', 'Industry', 'LinkedIn URL'];
const FULL_HEAD = CORE_HEAD.concat([
  'Email', 'Email Status', 'Role Currency', 'Priority', 'Verification', 'HQ', 'Company Page',
  'Evidence URL', 'Source Type'
]);

function personRow(p, comp, extended) {
  const verify = p.verification || (p.urlVerified ? 'Verified LinkedIn profile' : (p.url ? 'Unverified URL' : 'Unverified'));
  const row = [
    p.name, p.designation || '', comp.country || '', comp.name || '', comp.size || '',
    comp.industry || '', p.url || ''
  ];
  if (extended) {
    const roleTxt = ROLE_LABELS[p.currentEmployer] || '—';
    const sourceTxt = p.sourceType === 'official' ? 'Official company source' :
      (p.sourceType === 'linkedin' ? 'LinkedIn profile' : (p.sourceType === 'ai' ? 'AI-grounded' : ''));
    row.push(p.email || '', p.emailStatus || '', roleTxt, p.priority || '',
      verify, comp.hq || '', comp.url || '', p.evidenceUrl || '', sourceTxt);
  }
  return row.map(exportCell).join('\t');
}

/**
 * Build the TSV. core=false adds Email / Email Status / Priority / Verification / Company Page.
 * One row per person; companies with zero people get a single review row.
 */
export function buildTSV(companies, { core = false } = {}) {
  const head = (core ? CORE_HEAD : FULL_HEAD).join('\t');
  const lines = [head];
  const sorted = [...companies].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  for (const comp of sorted) {
    const people = [...(comp.people || [])].sort((a, b) =>
      (a.priority || 9) - (b.priority || 9) || (b.score || 0) - (a.score || 0));
    if (!people.length) {
      const reason = cell(comp.reviewReason || 'No decision-makers found — needs manual review');
      const row = ['—', reason, comp.country || '',
        comp.name || comp.input || '', comp.size || '', comp.industry || '', comp.url || ''];
      if (!core) row.push('', '', '', '', '', '', comp.url || '', '', '');
      lines.push(row.map(exportCell).join('\t'));
      continue;
    }
    for (const p of people) lines.push(personRow(p, comp, !core));
  }
  return lines.join('\n') + '\n';
}

/** Excel-friendly CSV (RFC-4180 quoting; caller prepends UTF-8 BOM). */
export function buildCSV(companies, { core = false } = {}) {
  const q = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = (core ? CORE_HEAD : FULL_HEAD);
  const lines = [head.join(',')];
  const tsv = buildTSV(companies, { core });
  const rows = tsv.split('\n').filter(Boolean);
  for (let i = 1; i < rows.length; i++) lines.push(rows[i].split('\t').map(q).join(','));
  return lines.join('\r\n') + '\r\n';
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
