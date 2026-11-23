// Deterministic prototype evaluation. All names, companies and excerpts are
// synthetic. The structured claims simulate model output.
import assert from 'node:assert/strict';
import { companyMatch, roleCurrency } from '../lib/parse.js';
import { verifyLead } from '../lib/verify-lead.js';
import { aiResearch, aiVerifyLead } from '../lib/ai.js';

const asOf = '2026-11-23';
const cases = [
  {
    company: 'Juniper Forge',
    name: 'Avery Example',
    title: 'CTO',
    headline: 'Avery Example - CTO at Juniper Forge',
    official: 'Avery Example serves as CTO at Juniper Forge.',
    expected: 'current'
  },
  {
    company: 'Harbor Circuit',
    name: 'Blair Example',
    title: 'Chief AI Officer',
    headline: 'Blair Example - Former Chief AI Officer at Harbor Circuit',
    expected: 'former'
  },
  {
    company: 'Summit Lattice',
    name: 'Casey Example',
    title: 'Head of Product',
    headline: 'Casey Example - Head of Product at Summit Lattice',
    expected: 'unverified'
  }
];

const results = cases.map(test => {
  const profile = {
    id: 'p1',
    kind: 'profile',
    url: 'https://www.linkedin.com/in/fixture-' + test.name.split(' ')[0].toLowerCase() + '/',
    excerpt: test.headline
  };
  const official = {
    id: 'o1',
    kind: 'official',
    url: 'https://example.com/leadership',
    publishedAt: '2026-11-01',
    excerpt: test.official
  };
  const claim = {
    name: test.name,
    designation: test.title,
    linkedinUrl: profile.url + '?trk=fixture',
    sourceIds: ['p1', 'o1']
  };
  const company = { name: test.company };
  const sources = test.official ? [profile, official] : [profile];
  const verified = verifyLead(company, claim, sources, asOf);
  assert.equal(verified.employment, test.expected);
  assert.equal(verified.linkedinUrl, profile.url);
  assert.equal(verified.designation, test.expected === 'current' ? test.title : null);
  assert.equal(verifyLead(company, { ...claim, linkedinUrl: 'https://www.linkedin.com/in/made-up/' }, sources, asOf).linkedinUrl, null);
  assert.equal(verifyLead(company, { ...claim, linkedinUrl: 'https://fake.example/linkedin.com/in/fixture/' }, sources, asOf).linkedinUrl, null);
  assert.equal(verifyLead(company, { ...claim, sourceIds: ['unknown'] }, sources, asOf).linkedinUrl, null);
  if (test.official) {
    assert.deepEqual(verified.roleSourceIds, ['o1']);
    assert.equal(verifyLead(company, { ...claim, sourceIds: ['unknown'] }, sources, asOf).employment, 'unverified');
    assert.equal(verifyLead({ name: 'Other Company' }, claim, sources, asOf).employment, 'unverified');
    assert.equal(verifyLead(company, claim, [profile, { ...official, publishedAt: '2024-01-01' }], asOf).employment, 'unverified');
    const conflict = { ...official, id: 'o2', excerpt: test.name + ' was ' + test.title + ' at ' + test.company + '.' };
    assert.equal(verifyLead(company, claim, [...sources, conflict], asOf).employment, 'unverified');
  }
  return {
    company: test.company,
    expected: test.expected,
    baseline: roleCurrency(companyMatch(test.headline, test.company), false, test.headline, '', test.company),
    prototype: verified.employment
  };
});

console.table(results);
for (const variant of ['baseline', 'prototype']) {
  const correct = results.filter(result => result[variant] === result.expected).length;
  const current = results.filter(result => result[variant] === 'current');
  const supported = current.filter(result => result.expected === 'current').length;
  console.log(variant + ' — correct statuses ' + correct + '/' + results.length +
    ', supported current labels ' + supported + '/' + current.length);
}

const publicCases = [
  {
    company: 'Atlassian',
    name: 'Mike Cannon-Brookes',
    designation: 'CEO and Co-Founder',
    publishedAt: '2026-11-05',
    url: 'https://www.atlassian.com/blog/company-news/shareholder-letter-q1fy27',
    excerpt: 'Mike Cannon-Brookes\nCEO and Co-Founder, Atlassian',
    expected: 'current'
  },
  {
    company: 'Freshworks',
    name: 'Dennis Woodside',
    designation: 'CEO and President',
    publishedAt: '2026-11-09',
    url: 'https://www.freshworks.com/pressrelease/freshworks-reports-record-third-quarter-2026-results/',
    excerpt: 'said Dennis Woodside, CEO & President of Freshworks.',
    expected: 'current'
  },
  {
    company: 'Adobe',
    name: 'Anil Chakravarthy',
    designation: 'president and chief executive officer',
    publishedAt: '2026-09-03',
    url: 'https://news.adobe.com/news/2026/09/adobe-announces-anil-chakravarthy-to-become-president-and-ceo',
    excerpt: 'Anil Chakravarthy, president of Adobe’s Customer Experience Orchestration business and worldwide field operations, will become Adobe’s next president and chief executive officer and join the Board of Directors effective December 1, 2026',
    effectiveDate: '2026-12-01',
    expected: 'incoming'
  }
];

console.table(publicCases.map(test => {
  const company = { name: test.company };
  const sources = [{ ...test, id: 'official', kind: 'official' }];
  const citation = { sourceId: 'official', quote: test.excerpt, effectiveDate: test.effectiveDate };
  const claim = {
    name: test.name,
    designation: test.designation,
    sourceIds: ['official'],
    roleCitations: [citation]
  };
  const result = verifyLead(company, claim, sources, asOf);
  assert.equal(result.employment, test.expected);
  assert.deepEqual(result.roleSourceIds, ['official']);
  for (const invalidCitation of [
    { ...citation, sourceId: 'missing' },
    { ...citation, quote: citation.quote.slice(0, -3) },
    { ...citation, effectiveDate: '2026-12-02' }
  ]) {
    assert.equal(verifyLead(company, { ...claim, roleCitations: [invalidCitation] }, sources, asOf)
      .employment, 'unverified');
  }
  if (test.effectiveDate) {
    assert.equal(result.designation, null);
    assert.equal(verifyLead(company, claim, sources, test.effectiveDate).employment, 'unverified');
  }
  return { company: test.company, expected: test.expected, prototype: result.employment };
}));

const realFetch = globalThis.fetch;
try {
  for (const provider of ['groq', 'gemini']) {
    let reply;
    let request;
    globalThis.fetch = async (_url, options) => {
      request = JSON.parse(options.body);
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      const body = provider === 'gemini'
        ? { candidates: [{ content: { parts: [{ text }] } }] }
        : { choices: [{ message: { content: text } }] };
      return new Response(JSON.stringify(body));
    };
    const settings = { keys: { [provider]: 'fixture-only' } };
    for (const test of publicCases) {
      const input = {
        provider, settings, asOf,
        company: { name: test.company },
        candidate: { name: test.name, designation: test.designation },
        sources: [{ ...test, id: 'official', kind: 'official' }]
      };
      const citation = { sourceId: 'official', quote: test.excerpt, effectiveDate: test.effectiveDate };
      reply = { roleCitations: [citation] };
      const result = await aiVerifyLead(input);
      assert.equal(result.employment, test.expected);
      assert.deepEqual(result.roleSourceIds, ['official']);
      const messages = provider === 'gemini' ? request.contents : request.messages;
      const payload = JSON.parse(provider === 'gemini' ? messages[0].parts[0].text : messages[1].content);
      assert.equal(payload.sources[0].excerpt, test.excerpt);
      assert.equal(payload.asOf, asOf);
      assert.equal(request.tools, undefined);
      for (const invalidReply of [
        { roleCitations: [{ ...citation, sourceId: 'invented' }] },
        { roleCitations: [{ ...citation, quote: 'fabricated text' }] },
        { roleCitations: [{ ...citation, quote: 42 }] },
        'unparseable provider output'
      ]) {
        reply = invalidReply;
        assert.equal((await aiVerifyLead(input)).employment, 'unverified');
      }
    }
    reply = { company: { industry: 'Software' }, people: [{ name: 'Fixture Name' }] };
    const research = await aiResearch({ provider, settings, companyName: 'Fixture', serp: [] });
    assert.equal(research.company.industry, 'Software');
    assert.equal(research.people[0].name, 'Fixture Name');
    console.log(provider + ' mocked provider checks passed');
  }
} finally {
  globalThis.fetch = realFetch;
}
