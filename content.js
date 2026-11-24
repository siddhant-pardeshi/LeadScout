// LeadScout — on-page extractor.
//
// This function is serialized by chrome.scripting.executeScript({ func }), so it
// must not reference imports or outer scope.  Everything it needs is nested.
// It only reads what is already rendered on the page the user is looking at.

export function extractPageLeads(options = {}) {
  const opts = options || {};
  const LIMIT = 150;

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? clean(el.innerText || el.textContent || '') : '');
  const linesOf = (el) => String((el && (el.innerText || el.textContent)) || '')
    .split(/\n+/).map(clean).filter(Boolean);
  const abs = (href) => {
    try { return new URL(href, location.href).href; } catch (e) { return ''; }
  };

  const COUNTRIES = [
    'United States', 'United Kingdom', 'United Arab Emirates', 'Saudi Arabia',
    'South Africa', 'New Zealand', 'South Korea', 'Sri Lanka', 'Netherlands',
    'Switzerland', 'Singapore', 'Australia', 'Bangladesh', 'Indonesia',
    'Malaysia', 'Philippines', 'Thailand', 'Vietnam', 'Pakistan', 'Germany',
    'France', 'Canada', 'Brazil', 'Mexico', 'India', 'Ireland', 'Israel',
    'Poland', 'Sweden', 'Spain', 'Italy', 'Japan', 'China', 'Nigeria',
    'Kenya', 'UAE', 'USA', 'UK'
  ];
  const countryIn = (text) => {
    const hay = ' ' + clean(text) + ' ';
    let best = '';
    for (const c of COUNTRIES) {
      if (new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(hay) && c.length > best.length) best = c;
    }
    return best;
  };

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const emailIn = (text) => {
    const m = String(text || '').match(EMAIL_RE);
    return m ? m[0].toLowerCase() : '';
  };

  const LINKEDIN_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[^/?#]+/i;
  const profileFrom = (href) => {
    const full = abs(href);
    const m = full.match(LINKEDIN_RE);
    if (!m) return '';
    try {
      const u = new URL(m[0]);
      return 'https://www.linkedin.com' + u.pathname.replace(/\/+$/, '') + '/';
    } catch (e) { return ''; }
  };

  const NAME_STOP = /^(home|about|contact|login|sign in|join now|search|people|jobs|notifications|me|my network|view profile|connect|message)$/i;
  const SECTION_HEAD = /^(our|the|meet|about|leadership|management|team|people|contact|careers?|board|advisors?)\b/i;
  const looksLikeName = (value) => {
    const v = clean(value);
    if (!v || v.length < 3 || v.length > 60) return false;
    if (NAME_STOP.test(v) || SECTION_HEAD.test(v)) return false;
    if (/[@|•·]/.test(v)) return false;
    if (/\s(?:at|@)\s/i.test(v)) return false;
    if (/\d/.test(v)) return false;
    const words = v.split(/\s+/);
    if (words.length < 2 || words.length > 5) return false;
    return words.every(w => /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*$/.test(w));
  };

  const splitName = (name) => {
    const parts = clean(name).replace(/^(?:(?:dr|mr|mrs|ms|mx|prof)\.?\s+)+/i, '').split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { firstName: parts[0] || '', lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  };

  const ROLE_HINT = /\b(ceo|cto|cio|coo|cfo|ciso|cpo|chief|founder|co-?founder|president|owner|partner|director|head|vp|vice president|manager|lead|principal|engineer|architect|scientist|analyst|consultant|officer|specialist)\b/i;
  const roleIn = (text) => {
    const lines = String(text || '').split(/\n+/).map(clean).filter(Boolean);
    return lines.find(l => ROLE_HINT.test(l) && l.length <= 160) || '';
  };
  const companyIn = (text) => {
    const m = clean(text).match(/\s+(?:at|@)\s+([^|•·\n]{2,80})/i);
    return m ? clean(m[1]) : '';
  };

  const websiteHost = () => {
    const h = location.hostname.replace(/^www\./i, '');
    return /linkedin\.com$/i.test(h) ? '' : h;
  };

  // ---------------------------------------------------------------- JSON-LD --
  const structured = [];
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || 'null');
      const walk = (value) => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (typeof value !== 'object') return;
        if (Array.isArray(value['@graph'])) value['@graph'].forEach(walk);
        structured.push(value);
      };
      walk(parsed);
    } catch (e) { /* malformed JSON-LD is ignored, never guessed */ }
  }
  const typed = (t) => structured.filter(n => {
    const type = n['@type'];
    return Array.isArray(type) ? type.includes(t) : type === t;
  });
  const orgNode = typed('Organization')[0] || typed('Corporation')[0] || typed('LocalBusiness')[0] || null;
  const orgName = orgNode ? clean(orgNode.name || '') : '';
  const orgCountry = orgNode && orgNode.address && typeof orgNode.address === 'object'
    ? clean(orgNode.address.addressCountry || '') : '';
  const countryName = (code) => ({
    IN: 'India', US: 'United States', GB: 'United Kingdom', AE: 'United Arab Emirates',
    SG: 'Singapore', DE: 'Germany', FR: 'France', JP: 'Japan', CN: 'China',
    CA: 'Canada', AU: 'Australia', BR: 'Brazil', MX: 'Mexico', NL: 'Netherlands',
    CH: 'Switzerland', IL: 'Israel', IE: 'Ireland', PL: 'Poland'
  }[String(code || '').toUpperCase()] || clean(code));

  if (opts.selectionOnly) {
    const sel = String(window.getSelection ? window.getSelection().toString() : '');
    return { context: 'selection', pageUrl: location.href, title: clean(document.title), rows: [], selection: String(sel || '').replace(/\r/g, '').trim() };
  }

  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const key = (row.linkedinUrl || '') + '|' + clean(row.firstName + ' ' + row.lastName).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (rows.length < LIMIT) rows.push(row);
  };

  const pageH1 = textOf(document.querySelector('h1'));
  /**
   * The nearest element that actually looks like one person's card.  Climbing
   * a fixed number of ancestors used to swallow the page <h1> and turn
   * "Our team" into a prospect.
   */
  const cardFor = (el) => el.closest('li, article, figure, [class*="card"], [class*="member"], [class*="person"], [class*="profile"], [class*="team"], [class*="bio"]')
    || (el.parentElement && el.parentElement.parentElement) || el;

  const nameFor = (card, anchor) => {
    const candidates = [];
    const aria = clean(anchor && (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || ''));
    if (aria) candidates.push(aria);
    for (const h of card.querySelectorAll('h1, h2, h3, h4, h5, strong, b')) candidates.push(textOf(h));
    candidates.push(...linesOf(card).slice(0, 6));
    return candidates.find(v => looksLikeName(v) && v !== pageH1) || '';
  };

  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(location.hostname);
  const path = location.pathname;

  // ------------------------------------------------------- A. LI profile ----
  if (isLinkedIn && /^\/in\//i.test(path)) {
    const h1 = document.querySelector('main h1') || document.querySelector('h1');
    const name = linesOf(h1)[0] || '';
    let headline = '';
    if (h1) {
      const scope = h1.closest('section') || h1.parentElement;
      const candidates = scope ? [...scope.querySelectorAll('div, p, span')] : [];
      headline = candidates.map(textOf).find(t =>
        t && t.length >= 12 && t.length <= 220 && !t.includes(name) &&
        !/^(contact info|followers?|connections?|message|connect|more)$/i.test(t) &&
        (ROLE_HINT.test(t) || /\s(?:at|@)\s/.test(t))) || '';
    }
    const topText = textOf((document.querySelector('main') || document.body)).slice(0, 1200);
    let company = companyIn(headline);
    if (!company) {
      const exp = [...document.querySelectorAll('section')].find(s => /^experience$/i.test(textOf(s.querySelector('h2, h3'))));
      const link = exp ? exp.querySelector('a[href*="/company/"]') : null;
      if (link) company = linesOf(link)[0] || '';
    }
    const profileUrl = 'https://www.linkedin.com' + path.replace(/\/+$/, '') + '/';
    add({
      firstName: splitName(name).firstName,
      lastName: splitName(name).lastName,
      designation: companyIn(headline) ? clean(headline.replace(/\s+(?:at|@)\s+.*$/i, '')) : headline,
      email: emailIn(topText),
      company,
      companySize: '',
      country: countryIn(topText),
      industry: '',
      website: '',
      linkedinUrl: profileUrl,
      status: 'direct',
      source: 'linkedin-profile'
    });
    return { context: 'profile', pageUrl: location.href, title: clean(document.title), rows };
  }

  // ---------------------------------------- B. LI search / people lists -----
  if (isLinkedIn) {
    const anchors = [...document.querySelectorAll('a[href*="/in/"], a[href*="/pub/"]')];
    for (const a of anchors) {
      const url = profileFrom(a.getAttribute('href') || '');
      if (!url) continue;
      let card = a.closest('li');
      if (!card) {
        card = a;
        for (let i = 0; i < 5 && card.parentElement; i++) {
          card = card.parentElement;
          if (card.querySelectorAll('a[href*="/in/"]').length > 1) break;
        }
      }
      const cardText = textOf(card);
      let name = linesOf(a)[0] || '';
      if (!looksLikeName(name)) {
        const first = linesOf(card).find(looksLikeName);
        name = first || '';
      }
      if (!looksLikeName(name)) continue;
      const lines = linesOf(card);
      const roleLine = lines.find(l => l !== name && (ROLE_HINT.test(l) || /\s(?:at|@)\s/.test(l))) || '';
      add({
        firstName: splitName(name).firstName,
        lastName: splitName(name).lastName,
        designation: companyIn(roleLine) ? clean(roleLine.replace(/\s+(?:at|@)\s+.*$/i, '')) : roleLine,
        email: emailIn(cardText),
        company: companyIn(roleLine),
        companySize: '',
        country: countryIn(cardText),
        industry: '',
        website: '',
        linkedinUrl: url,
        status: 'direct',
        source: 'linkedin-list'
      });
    }
    if (rows.length) return { context: 'list', pageUrl: location.href, title: clean(document.title), rows };
  }

  // ------------------------------- C. company / team / directory pages -----
  const site = websiteHost();
  const ogSite = document.querySelector('meta[property="og:site_name"]');
  const siteCompany = orgName || clean(ogSite && ogSite.content ? ogSite.content : '');
  const pageCountry = countryName(orgCountry) || countryIn(textOf(document.body).slice(0, 4000));
  const siteIndustry = '';

  // C1 — JSON-LD Person entries are the most reliable.
  for (const person of typed('Person')) {
    const name = clean(person.name || [person.givenName, person.familyName].filter(Boolean).join(' '));
    if (!looksLikeName(name)) continue;
    const works = person.worksFor;
    const worksName = Array.isArray(works) ? clean(works[0] && works[0].name) : clean(works && works.name);
    const addr = person.address && typeof person.address === 'object' ? person.address : {};
    add({
      firstName: splitName(name).firstName,
      lastName: splitName(name).lastName,
      designation: clean(person.jobTitle || ''),
      // Only this person's own declared email. A page-wide address would be
      // attached to everyone in the JSON-LD block, which is misattribution.
      email: clean(person.email || '').replace(/^mailto:/i, '').toLowerCase(),
      company: worksName || siteCompany,
      companySize: '',
      country: countryName(addr.addressCountry) || countryIn([addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ')) || pageCountry,
      industry: siteIndustry,
      website: site,
      linkedinUrl: profileFrom(person.sameAs && (Array.isArray(person.sameAs) ? person.sameAs.find(u => /linkedin\.com\/(?:in|pub)\//i.test(u)) : person.sameAs)),
      status: 'direct',
      source: 'json-ld'
    });
  }

  // C2 — LinkedIn anchors on team cards.
  for (const a of document.querySelectorAll('a[href*="linkedin.com/in/"], a[href*="/in/"]')) {
    const url = profileFrom(a.getAttribute('href') || '');
    if (!url) continue;
    const card = cardFor(a);
    const cardText = textOf(card);
    const name = nameFor(card, a);
    if (!name) continue;
    const roleLine = roleIn(linesOf(card).join('\n').replace(name, ''));
    add({
      firstName: splitName(name).firstName,
      lastName: splitName(name).lastName,
      designation: roleLine,
      email: emailIn(cardText),
      company: siteCompany,
      companySize: '',
      country: pageCountry,
      industry: siteIndustry,
      website: site,
      linkedinUrl: url,
      status: 'direct',
      source: 'team-anchor'
    });
  }

  // C3 — mailto anchors with a nearby name.
  for (const a of document.querySelectorAll('a[href^="mailto:"]')) {
    const email = clean(a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]).toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    const card = cardFor(a);
    const cardText = textOf(card);
    const name = nameFor(card, a);
    if (!name) continue;
    add({
      firstName: splitName(name).firstName,
      lastName: splitName(name).lastName,
      designation: roleIn(linesOf(card).join('\n').replace(name, '')),
      email,
      company: siteCompany,
      companySize: '',
      country: pageCountry,
      industry: siteIndustry,
      website: site,
      linkedinUrl: '',
      status: '',
      source: 'mailto'
    });
  }

  // C4 — heading + paragraph team cards (no links at all).
  if (!rows.length) {
    for (const h of document.querySelectorAll('h2, h3, h4')) {
      const name = textOf(h).replace(/\s*[|—-]\s*.*$/, '');
      if (!looksLikeName(name)) continue;
      const card = h.closest('li, article, div') || h.parentElement;
      const cardText = textOf(card);
      const roleLine = roleIn(linesOf(card).join('\n').replace(name, ''));
      if (!roleLine) continue;
      add({
        firstName: splitName(name).firstName,
        lastName: splitName(name).lastName,
        designation: roleLine,
        email: emailIn(cardText),
        company: siteCompany,
        companySize: '',
        country: pageCountry,
        industry: siteIndustry,
        website: site,
        linkedinUrl: '',
        status: '',
        source: 'team-card'
      });
    }
  }

  // The same person often appears twice: a LinkedIn anchor row and a mailto
  // row. Merge on name so one human is one row.
  const consolidated = [];
  for (const row of rows) {
    const hit = consolidated.find(o =>
      o.firstName && row.firstName &&
      o.firstName.toLowerCase() === row.firstName.toLowerCase() &&
      o.lastName.toLowerCase() === row.lastName.toLowerCase());
    if (!hit) { consolidated.push({ ...row }); continue; }
    for (const k of Object.keys(row)) if (!hit[k] && row[k]) hit[k] = row[k];
  }

  return {
    context: rows.length ? (isLinkedIn ? 'list' : 'team') : 'generic',
    pageUrl: location.href,
    title: clean(document.title),
    site,
    rows: consolidated
  };
}
