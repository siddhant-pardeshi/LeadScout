// Compare the role classifier and evidence verifier on fixed public excerpts.
import { aiVerifyLead } from '../lib/ai.js';
import { companyMatch, roleCurrency } from '../lib/parse.js';
import { verifyLead } from '../lib/verify-lead.js';

const asOf = '2026-11-23';
// Each expected label describes the requested role, not overall employment.
const cases = [
  ['Atlassian', 'Mike Cannon-Brookes', 'CEO and Co-Founder', 'current', '2026-11-05',
    'https://www.atlassian.com/blog/company-news/shareholder-letter-q1fy27',
    'Mike Cannon-Brookes\nCEO and Co-Founder, Atlassian'],
  ['Freshworks', 'Dennis Woodside', 'CEO and President', 'current', '2026-11-09',
    'https://www.freshworks.com/pressrelease/freshworks-reports-record-third-quarter-2026-results/',
    'said Dennis Woodside, CEO & President of Freshworks.'],
  ['Adobe', 'Anil Chakravarthy', 'President and Chief Executive Officer', 'incoming', '2026-09-03',
    'https://news.adobe.com/news/2026/09/adobe-announces-anil-chakravarthy-to-become-president-and-ceo',
    'Anil Chakravarthy, president of Adobe’s Customer Experience Orchestration business and worldwide field operations, will become Adobe’s next president and chief executive officer and join the Board of Directors effective December 1, 2026',
    '2026-12-01'],
  ['Salesforce', 'Marc Benioff', 'Chair and CEO', 'current', '2026-09-03',
    'https://investor.salesforce.com/news/news-details/2026/Salesforce-Delivers-Record-Second-Quarter-Fiscal-2027-Results/default.aspx',
    'said Marc Benioff, Chair and CEO, Salesforce.'],
  ['Datadog', 'Olivier Pomel', 'Co-Founder and CEO', 'current', '2026-11-05',
    'https://investors.datadoghq.com/news-releases/news-release-details/datadog-announces-third-quarter-2026-financial-results',
    'said Olivier Pomel, co-founder and CEO of Datadog.'],
  ['ServiceNow', 'Bill McDermott', 'Chairman and CEO', 'current', '2026-10-28',
    'https://investor.servicenow.com/news/news-details/2026/ServiceNow-Reports-Third-Quarter-2026-Financial-Results/default.aspx',
    'said ServiceNow Chairman and CEO Bill McDermott.'],
  ['Snowflake', 'Sridhar Ramaswamy', 'CEO', 'current', '2026-08-26',
    'https://investors.snowflake.com/financials/quarterly-results/default.aspx',
    'said Sridhar Ramaswamy, CEO of Snowflake.'],
  ['GitLab', 'Bill Staples', 'Chief Executive Officer', 'current', '2026-09-01',
    'https://about.gitlab.com/press/releases/2026-09-01-gitlab-reports-second-quarter-fiscal-year-2027-financial-results/',
    'said Bill Staples, GitLab Chief Executive Officer.'],
  ['Cloudflare', 'Matthew Prince', 'Co-Founder and CEO', 'current', '2026-11-05',
    'https://www.cloudflare.com/es-la/press/press-releases/2026/cloudflare-announces-third-quarter-2026-financial-results/',
    'said Matthew Prince, co-founder & CEO of Cloudflare.'],
  ['HubSpot', 'Yamini Rangan', 'Chief Executive Officer', 'former', '2026-11-12',
    'https://www.hubspot.com/company-news/leadership-transition',
    'HubSpot today announced that Yamini Rangan will step down as Chief Executive Officer and from the Board, effective November 12, 2026.'],
  ['GitLab', 'Bill Staples', 'Chief Product Officer', 'unverified', '2026-09-01',
    'https://about.gitlab.com/press/releases/2026-09-01-gitlab-reports-second-quarter-fiscal-year-2027-financial-results/',
    'said Bill Staples, GitLab Chief Executive Officer.']
];

const keyNames = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const mode = process.argv[2];
const keyName = Object.hasOwn(keyNames, mode) ? keyNames[mode] : null;
if (mode !== '--offline' && (!keyName || !process.env[keyName]?.trim())) {
  console.error('Usage: node tools/live-eval-evidence.mjs --offline|groq|gemini|openrouter');
  if (keyName) console.error('Set ' + keyName + ' in the environment to run live.');
  process.exit(2);
}

const rows = [];
for (const [companyName, name, designation, expected, publishedAt, url, excerpt, effectiveDate] of cases) {
  const company = { name: companyName };
  const candidate = { name, designation };
  const sources = [{ id: 'official', kind: 'official', publishedAt, url, excerpt }];
  const baseline = roleCurrency(companyMatch(excerpt, companyName), false, excerpt, '', companyName);
  let result;
  try {
    result = mode === '--offline'
      ? verifyLead(company, {
        ...candidate, sourceIds: ['official'],
        roleCitations: [{ sourceId: 'official', quote: excerpt, effectiveDate }]
      }, sources, asOf)
      : await aiVerifyLead({
        provider: mode, settings: { keys: { [mode]: process.env[keyName].trim() } },
        company, candidate, sources, asOf
      });
  } catch {
    // Preserve coverage counts while keeping provider errors distinct from abstentions.
    result = { employment: 'provider error' };
    process.exitCode = 1;
  }
  rows.push({ company: companyName, name, designation, expected, baseline, verifier: result.employment });
}

console.log('Evaluation date ' + asOf + ' · ' +
  (mode === '--offline' ? 'offline, hand-authored citations' : 'live provider ' + mode));
console.table(rows);
for (const variant of ['baseline', 'verifier']) {
  const predictedCurrent = rows.filter(row => row[variant] === 'current');
  const expectedCurrent = rows.filter(row => row.expected === 'current');
  const trueCurrent = predictedCurrent.filter(row => row.expected === 'current').length;
  const sentToReview = expectedCurrent.filter(row => row[variant] === 'unverified' || row[variant] === 'snippet').length;
  console.log(variant + ': current-label precision ' + trueCurrent + '/' + predictedCurrent.length +
    ', current-role recall ' + trueCurrent + '/' + expectedCurrent.length +
    ', confirmed current sent to review ' + sentToReview + '/' + expectedCurrent.length +
    ', provider errors ' + rows.filter(row => row[variant] === 'provider error').length);
}
