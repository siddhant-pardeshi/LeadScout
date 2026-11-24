// LeadScout — Hunter.io domain-search client (optional, free tier).
// With a free Hunter key (25 searches/month at hunter.io) the extension can
// attach REAL emails for people at a company domain instead of only pattern
// estimates. Everything degrades gracefully: any error returns null and the
// pipeline falls back to pattern estimation, still clearly flagged.

import { assertSafeUrl } from './ai.js';

const ENDPOINT = 'https://api.hunter.io/v2/domain-search';

/**
 * @param {string} domain  corporate domain, e.g. "acme.io"
 * @param {string} apiKey  Hunter.io API key
 * @returns {Promise<{emails:Array, pattern:object|null}|null>} null on any failure
 */
export async function hunterDomainSearch(domain, apiKey) {
  if (!domain || !apiKey) return null;
  let url;
  try {
    url = assertSafeUrl(ENDPOINT +
      '?domain=' + encodeURIComponent(domain) +
      '&api_key=' + encodeURIComponent(apiKey) +
      '&limit=50');
  } catch (e) {
    return null;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;             // 401 bad key, 429 quota — fall back silently
    const data = await res.json();
    const d = data && data.data;
    if (!d) return null;
    const emails = (Array.isArray(d.emails) ? d.emails : [])
      .map(e => ({
        value: String(e.value || ''),
        first_name: String(e.first_name || ''),
        last_name: String(e.last_name || ''),
        position: String(e.position || '')
      }))
      .filter(e => e.value);
    const patternTemplate = d.pattern ? String(d.pattern) : null;
    return { emails: emails, patternTemplate: patternTemplate };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}
