// Offline prototype. Sources are classified by the caller; model claims cannot
// assign source types or introduce new sources.
const ROLE_SOURCES = new Set(['official', 'credible']);
const MAX_SOURCE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function normalize(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function profileUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(url.hostname) ||
        !/^\/in\/[a-z\d-]+\/?$/i.test(url.pathname)) return null;
    return 'https://www.linkedin.com' + url.pathname.toLowerCase().replace(/\/$/, '') + '/';
  } catch {
    return null;
  }
}

// Accept only explicit statements in this prototype. Unrecognized wording
// goes to review. Retrieval time alone does not establish publication freshness.
function roleEvidence(text, name, title, company) {
  const lines = text.split(/\r?\n/).map(line => normalize(line).replace(/\.$/, ''));
  const person = normalize(name);
  const designation = normalize(title);
  const employer = normalize(company);
  if (!person || !designation || !employer) return null;
  const role = designation + ' at ' + employer;
  if (lines.includes(person + ' is former ' + role) ||
      lines.includes(person + ' was ' + role) ||
      lines.includes(person + ' - former ' + role) ||
      lines.includes(person + ' - ex-' + role)) return 'former';
  if (lines.includes(person + ' is ' + role) ||
      lines.includes(person + ' serves as ' + role)) return 'current';
  return null;
}

function datedRoleEvidence(source, citation, name, title, company, evaluatedAt) {
  const excerpt = String(source.excerpt ?? '');
  const quote = typeof citation?.quote === 'string' ? citation.quote.trim() : '';
  // Use the complete saved excerpt so a citation cannot drop qualifiers.
  if (!quote || quote !== excerpt.trim()) return null;
  const text = normalize(quote).replace(/\.$/, '').replace(/&/g, 'and');
  const person = normalize(name);
  const designation = normalize(title).replace(/&/g, 'and');
  const employer = normalize(company);
  if (!person || !designation || !employer) return null;

  const appointment = person + ' will become ' + employer + '’s next ' + designation + ' effective ';
  const appointmentText = text.replace(
    /, president of [^,]+, will become /, ' will become '
  ).replace(' and join the board of directors effective ', ' effective ');
  if (appointmentText.startsWith(appointment)) {
    const dateText = appointmentText.slice(appointment.length);
    if (!/^[a-z]+ \d{1,2}, \d{4}$/.test(dateText)) return null;
    const effectiveAt = Date.parse(dateText + ' UTC');
    if (!Number.isFinite(effectiveAt) ||
        new Date(effectiveAt).toISOString().slice(0, 10) !== citation.effectiveDate) return null;
    // Once the date arrives, seek evidence that the appointment went through.
    return effectiveAt > evaluatedAt ? 'incoming' : null;
  }

  if (citation.effectiveDate) return null;
  const presentStatements = [
    person + ' is the ' + designation + ' of ' + employer,
    'said ' + person + ', ' + designation + ' of ' + employer,
    person + ' ' + designation + ', ' + employer
  ];
  return presentStatements.includes(text) ? 'current' : null;
}

export function verifyLead(company, claim, sources, asOf) {
  const citedIds = new Set(claim.sourceIds);
  const citations = new Map((claim.roleCitations ?? []).filter(Boolean)
    .map(citation => [citation.sourceId, citation]));
  const roleSources = [];
  const profileSources = [];
  const candidateUrl = profileUrl(claim.linkedinUrl);
  const evaluatedAt = Date.parse(asOf);

  for (const source of sources) {
    const excerpt = String(source.excerpt ?? '');
    const statement = roleEvidence(excerpt, claim.name, claim.designation, company.name);
    const citation = citations.get(source.id);
    const citedStatement = citation && datedRoleEvidence(
      source, citation, claim.name, claim.designation, company.name, evaluatedAt
    );
    const publishedAt = Date.parse(source.publishedAt);
    const age = evaluatedAt - publishedAt;
    // Scan all retrieved excerpts for contradictory evidence, even if omitted
    // by the model. Positive evidence must also have been cited by the model.
    const positive = claim.roleCitations === undefined ? statement :
      (citedStatement ?? (citation?.quote === excerpt.trim() && !citation.effectiveDate ? statement : null));
    if ((statement === 'former' && (ROLE_SOURCES.has(source.kind) || source.kind === 'profile')) ||
        ((positive === 'current' || positive === 'incoming') && citedIds.has(source.id) &&
         ROLE_SOURCES.has(source.kind) && age >= 0 && age <= MAX_SOURCE_AGE_MS)) {
      roleSources.push({ id: source.id, status: statement === 'former' ? statement : positive });
    }
    const headlineName = normalize(excerpt.split(' - ')[0]);
    if (citedIds.has(source.id) && source.kind === 'profile' && candidateUrl &&
        profileUrl(source.url) === candidateUrl &&
        excerpt.includes(' - ') && headlineName === normalize(claim.name)) {
      profileSources.push(source.id);
    }
  }

  const former = roleSources.some(source => source.status === 'former');
  const current = roleSources.some(source => source.status === 'current');
  const incoming = roleSources.some(source => source.status === 'incoming');
  let employment = 'unverified';
  if (former && !current && !incoming) employment = 'former';
  if (current && !former && !incoming) employment = 'current';
  if (incoming && !former && !current) employment = 'incoming';
  return {
    employment,
    designation: employment === 'current' ? claim.designation : null,
    linkedinUrl: profileSources.length ? candidateUrl : null,
    roleSourceIds: roleSources.map(source => source.id),
    profileSourceIds: profileSources
  };
}
