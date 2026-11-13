import { describe, expect, it } from 'vitest';
import { buildRecommendations, llmsTxtDraft, schemaDraft, sourcesWithoutYou, TITLES } from '../src/lib/recommendations.ts';
import { computeScore, computeShareOfVoice } from '../src/lib/scoring.ts';
import { analyzeAnswers } from '../src/lib/analyze.ts';
import { checkFacts } from '../src/lib/facts.ts';
import type { AnswerAnalysis, BusinessInput, EngineAnswer, EngineId, KnownFacts, Recommendation, SiteAudit } from '../src/lib/types.ts';
import { business, siteAudit } from './fixtures.ts';

function a(engine: EngineId, overrides: Partial<AnswerAnalysis> = {}): AnswerAnalysis {
  return {
    engine,
    prompt: 'p',
    ok: true,
    mentioned: false,
    matchType: null,
    matchedText: null,
    position: null,
    listLength: 0,
    competitors: [],
    citations: [],
    domainCited: false,
    ...overrides,
  };
}
const named = (engine: EngineId, position: number | null = 1) =>
  a(engine, { mentioned: true, matchType: 'exact', matchedText: 'Example Studio', position, listLength: position ? 5 : 0 });

interface Opts {
  input?: BusinessInput;
  cited?: { domain: string; count: number }[];
  audit?: SiteAudit | null;
  auditStatus?: string;
}

function run(analyses: AnswerAnalysis[], opts: Opts = {}) {
  const input = opts.input ?? business();
  return buildRecommendations({
    business: input,
    analyses,
    score: computeScore(analyses),
    shareOfVoice: computeShareOfVoice(analyses, input),
    topCitedDomains: opts.cited ?? [],
    audit: opts.audit ?? null,
    auditStatus: opts.auditStatus ?? 'off',
  });
}

const byId = (recs: Recommendation[]) => Object.fromEntries(recs.map((r) => [r.id, r]));
const whyEn = (r: Recommendation | undefined) => (r?.why ?? []).map((w) => w.en).join(' ');
const stepsEn = (r: Recommendation | undefined) => (r?.steps ?? []).map((w) => w.en).join(' ');

const FACTS: KnownFacts = {
  officialName: 'Example Studio',
  nameVariants: ['Егзампл Студио'],
  phones: ['02 555 0100'],
  prices: [
    { label: 'One Page website', amount: 190, currency: 'EUR', perMonth: false },
    { label: 'Social media management', amount: 150, currency: 'EUR', perMonth: true },
  ],
  city: 'Skopje',
  address: '',
};

/** Full pipeline from raw answers, as buildReport does it. */
function fromAnswers(answers: EngineAnswer[], audit: SiteAudit | null, facts: KnownFacts | null = FACTS, input = business()) {
  const analyses = analyzeAnswers(answers, input);
  const score = computeScore(analyses);
  return buildRecommendations({
    business: input,
    analyses,
    score,
    shareOfVoice: computeShareOfVoice(analyses, input),
    topCitedDomains: [],
    audit,
    auditStatus: audit ? 'done' : 'off',
    factCheck: checkFacts({ business: input, facts, answers, analyses }),
    facts,
  });
}
const ans = (engine: EngineId, text: string, citations: string[] = []): EngineAnswer => ({
  engine,
  model: 'm',
  prompt: 'best web design agency in Skopje?',
  ok: true,
  text,
  citations,
  latencyMs: 1,
});

describe('buildRecommendations: visibility-only rules (no audit)', () => {
  it('returns nothing when no engine answered', () => {
    expect(run([a('openai', { ok: false })])).toEqual([]);
  });

  it('puts the fundamentals at high priority when the business is invisible, and says the site was not audited', () => {
    const recs = byId(run([a('openai'), a('anthropic'), a('openai'), a('anthropic')]));
    expect(recs['google-business-profile']!.priority).toBe('high');
    expect(recs['schema-localbusiness']!.priority).toBe('high');
    expect(recs['service-pages']!.priority).toBe('high');
    expect(whyEn(recs['google-business-profile'])).toContain('Named in 0 of 4 answers (0%)');
    expect(whyEn(recs['schema-localbusiness'])).toContain('was not audited');
    expect(recs['schema-localbusiness']!.why[0]!.mk).toContain('не беше проверен');
  });

  it('keeps maintenance items low when the business is leading', () => {
    const recs = byId(run([named('openai'), named('anthropic'), named('perplexity')]));
    expect(recs['google-business-profile']!.priority).toBe('low');
    expect(recs['schema-localbusiness']!.priority).toBe('low');
    expect(recs['consistent-nap']!.priority).toBe('low');
    expect(recs['llms-txt']!.priority).toBe('low');
    expect(recs.reviews).toBeUndefined();
    expect(recs['service-pages']).toBeUndefined();
  });

  it('flags reviews when a competitor is named more often', () => {
    const input = business({ competitors: ['Northpine Web'] });
    const recs = byId(
      run(
        [
          { ...named('openai', 2), competitors: [{ name: 'Northpine Web', position: 1 }] },
          { ...a('anthropic'), competitors: [{ name: 'Northpine Web', position: 1 }] },
        ],
        { input },
      ),
    );
    expect(recs.reviews!.priority).toBe('high');
    expect(whyEn(recs.reviews)).toContain('Northpine Web was named 2 times against your 1');
    expect(recs.reviews!.why[0]!.mk).toContain('Northpine Web беше спомнат 2 пати, а вие 1');
  });

  it('flags inconsistent details when only some engines name the business', () => {
    const recs = byId(run([named('openai'), named('openai'), a('anthropic'), named('openai')]));
    expect(recs['consistent-nap']!.priority).toBe('high');
    expect(whyEn(recs['consistent-nap'])).toContain('Named by ChatGPT but not by Claude');
  });

  it('recommends directories from sources cited in answers that did not name the business', () => {
    const recs = byId(
      run([
        a('perplexity', { citations: ['https://clutch.co/x', 'https://www.goodfirms.co/y', 'https://examplestudio.example/'] }),
        a('perplexity', { citations: ['https://clutch.co/z'] }),
        named('perplexity', 1),
      ]),
    );
    const dir = recs['directory-citations']!;
    expect(dir.priority).toBe('high');
    expect(whyEn(dir)).toContain('clutch.co (2), goodfirms.co (1)');
    expect(whyEn(dir)).not.toContain('examplestudio.example (');
    expect(dir.steps[0]!.en).toBe('Check whether you are listed on: clutch.co, goodfirms.co. If not, create a profile; if yes, complete it.');
  });

  it('adds Macedonian content only for Macedonian runs with low visibility', () => {
    const mk = byId(run([a('openai'), a('anthropic')], { input: business({ language: 'mk' }) }));
    expect(mk['local-language-content']!.priority).toBe('high');
    const en = byId(run([a('openai'), a('anthropic')]));
    expect(en['local-language-content']).toBeUndefined();
  });

  it('always includes Bing for Copilot, and says Copilot is not measured', () => {
    const recs = byId(run([named('openai')]));
    expect(recs.bing!.status).toBe('todo');
    expect(whyEn(recs.bing)).toContain('cannot test Copilot');
  });

  it('raises Google Business Profile when Gemini answered but never named the business', () => {
    const recs = byId(run([named('openai'), named('openai'), named('anthropic'), a('gemini'), named('perplexity')]));
    expect(recs['google-business-profile']!.priority).toBe('high');
    expect(whyEn(recs['google-business-profile'])).toContain('Gemini named you in 0 of 1 answers');
  });

  it('sorts todo items by priority, puts done items last, and uses catalogue titles in both languages', () => {
    const recs = run([named('openai', 4), a('anthropic'), a('perplexity', { citations: ['https://x.test'] })], { audit: siteAudit() });
    const todo = recs.filter((r) => r.status === 'todo');
    const ranks = todo.map((r) => ({ high: 0, medium: 1, low: 2 })[r.priority]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(recs.slice(todo.length).every((r) => r.status === 'done')).toBe(true);
    for (const r of recs) {
      expect(r.title).toEqual(TITLES[r.id]);
      expect(r.title.mk).toMatch(/[Ѐ-ӿ]/);
      for (const w of [...r.why, ...r.steps]) {
        expect(w.en.length).toBeGreaterThan(0);
        expect(w.mk.length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic', () => {
    const analyses = [named('openai', 3), a('anthropic')];
    expect(run(analyses, { audit: siteAudit() })).toEqual(run(analyses, { audit: siteAudit() }));
  });
});

describe('buildRecommendations: with a website audit', () => {
  const mixed = [named('openai', 2), a('anthropic'), named('gemini', 3), a('perplexity')];

  it('marks items as done when the audit shows they are in place', () => {
    const recs = byId(run(mixed, { audit: siteAudit() }));
    for (const id of ['schema-localbusiness', 'llms-txt', 'service-pages', 'local-language-content', 'ai-crawlers'] as const) {
      expect(recs[id]!.status, id).toBe('done');
      expect(recs[id]!.snippet).toBeUndefined();
    }
    expect(whyEn(recs['schema-localbusiness'])).toBe('Schema on examplestudio.example has name, telephone, address, prices and sameAs links.');
  });

  it('cites the missing schema and the missing fields from the site', () => {
    const none = byId(run(mixed, { audit: siteAudit({ schema: { ...siteAudit().schema, present: false, types: [], invalidBlocks: 1 } }) }));
    expect(none['schema-localbusiness']).toMatchObject({ status: 'todo', priority: 'high' });
    expect(whyEn(none['schema-localbusiness'])).toContain('No LocalBusiness or Organization schema (JSON-LD) found on examplestudio.example.');
    expect(none['schema-localbusiness']!.why[0]!.mk).toBe('На examplestudio.example нема LocalBusiness ни Organization schema (JSON-LD).');
    expect(none['schema-localbusiness']!.snippet!.code).toContain('"@type": "ProfessionalService"');

    const partial = byId(
      run(mixed, { audit: siteAudit({ schema: { ...siteAudit().schema, priceRange: null, hasOffers: false, sameAs: [] } }) }),
    );
    expect(partial['schema-localbusiness']).toMatchObject({ status: 'todo', priority: 'medium' });
    expect(whyEn(partial['schema-localbusiness'])).toContain('missing: priceRange or offers, sameAs links to your profiles');
  });

  it('reports llms.txt, blocked AI crawlers and one-page services from the audit', () => {
    const audit = siteAudit({
      llmsTxt: { state: 'missing', status: 404, bytes: 0 },
      robots: { state: 'present', blockedAiBots: ['GPTBot', 'Google-Extended'] },
      services: { pages: [], sectionAnchors: 3, pricingPage: null },
    });
    const recs = byId(run(mixed, { audit }));
    expect(whyEn(recs['llms-txt'])).toBe('examplestudio.example/llms.txt was not found (HTTP 404).');
    expect(recs['llms-txt']!.snippet!.code.startsWith('# Example Studio')).toBe(true);
    expect(recs['ai-crawlers']).toMatchObject({ status: 'todo', priority: 'high' });
    expect(whyEn(recs['ai-crawlers'])).toContain('blocks: GPTBot, Google-Extended');
    expect(whyEn(recs['service-pages'])).toContain('sections of one page');
  });

  it('flags a Macedonian-only site and mobile/speed problems', () => {
    const audit = siteAudit({
      viewport: false,
      languages: { htmlLang: 'mk', hreflang: [], cyrillicShare: 0.9, hasMk: true, hasEn: false, switcherLinks: [] },
      psi: { performance: 31, seo: 80, accessibility: 70, bestPractices: 80, lcpMs: 6200, cls: 0.1, tbtMs: 500 },
      psiStatus: 'ok',
    });
    const recs = byId(run(mixed, { audit }));
    expect(whyEn(recs['local-language-content'])).toContain('looks Macedonian-only');
    expect(recs['page-speed']).toMatchObject({ status: 'todo', priority: 'high' });
    expect(whyEn(recs['page-speed'])).toContain('PageSpeed mobile performance is 31/100');
    expect(whyEn(recs['page-speed'])).toContain('6.2 s');
    // No speed item when PageSpeed did not run and the basics are fine.
    expect(byId(run(mixed, { audit: siteAudit() }))['page-speed']).toBeUndefined();
  });
});

describe('buildRecommendations: facts and names from the answers', () => {
  const chatgpt = ans(
    'openai',
    '1. **Example Studio Digital Agency** – websites from €190. Call 02 555 0100.\n2. **Northpine Web** – e-commerce.',
  );
  const gemini = ans(
    'gemini',
    '**1. Example Studio**\n* **Pricing:** social media management typically costs €300–400 per month.\n\n**2. Northpine Web**\n* from €900',
  );

  it('turns a wrong Gemini price into a high-priority fix with where-to-update steps', () => {
    const recs = byId(fromAnswers([chatgpt, gemini], siteAudit()));
    const fix = recs['fix-wrong-facts']!;
    expect(fix).toMatchObject({ status: 'todo', priority: 'high' });
    expect(whyEn(fix)).toBe('Gemini stated €300–400 per month; your price for Social media management is from €150/month.');
    expect(fix.why[0]!.mk).toBe('Gemini наведе €300–400 per month; вашата цена за Social media management е од €150 месечно.');
    expect(stepsEn(fix)).toContain('https://examplestudio.example/ceni');
    expect(stepsEn(fix)).toContain('Google Business Profile');
    expect(recs['google-business-profile']!.priority).toBe('high');
    expect(whyEn(recs['google-business-profile'])).toContain('Gemini stated €300–400 per month');
    expect(stepsEn(recs['google-business-profile'])).toContain('One Page website from €190; Social media management from €150/month');
  });

  it('uses the name variants the answers used', () => {
    const recs = byId(fromAnswers([chatgpt, gemini], siteAudit()));
    const nap = recs['consistent-nap']!;
    expect(whyEn(nap)).toBe('ChatGPT called you "Example Studio Digital Agency" (1 answer); your site says "Example Studio".');
    expect(nap.why[0]!.mk).toBe('ChatGPT ве нарече „Example Studio Digital Agency“ (1 одговор); на сајтот пишува „Example Studio“.');
    expect(stepsEn(nap)).toContain('Search the web for "Example Studio Digital Agency"');
  });

  it('marks facts as done when every checked fact was correct', () => {
    const recs = byId(fromAnswers([chatgpt], siteAudit()));
    expect(recs['fix-wrong-facts']).toMatchObject({ status: 'done' });
    expect(whyEn(recs['fix-wrong-facts'])).toContain('stated 2 of your facts correctly');
  });

  it('lists known services that have no page of their own', () => {
    const audit = siteAudit({
      services: {
        pages: [
          { url: 'https://examplestudio.example/uslugi/web-dizajn', text: 'One page websites' },
          { url: 'https://examplestudio.example/branding', text: 'Branding' },
        ],
        sectionAnchors: 0,
        pricingPage: null,
      },
    });
    const recs = byId(fromAnswers([chatgpt], audit));
    expect(whyEn(recs['service-pages'])).toBe('No page found for: Social media management.');
  });

  it('flags a phone on the site that differs from the known number', () => {
    const audit = siteAudit({ phonesOnSite: ['070 111 222'], schema: { ...siteAudit().schema, telephone: '070 111 222' } });
    const recs = byId(fromAnswers([chatgpt], audit));
    expect(whyEn(recs['consistent-nap'])).toContain('The home page shows 070 111 222, not 02 555 0100.');
    expect(whyEn(recs['schema-localbusiness'])).toContain('The schema telephone is 070 111 222');
  });
});

describe('drafts', () => {
  it('builds a JSON-LD draft from the known facts without inventing URLs', () => {
    const code = schemaDraft(business({ aliases: ['Егзампл Студио'] }), FACTS, siteAudit());
    const json = JSON.parse(code.replace(/^<script[^>]*>\n/, '').replace(/\n<\/script>$/, '')) as Record<string, unknown>;
    expect(json).toMatchObject({
      '@type': 'ProfessionalService',
      name: 'Example Studio',
      alternateName: ['Егзампл Студио'],
      url: 'https://examplestudio.example/',
      telephone: '02 555 0100',
      address: { '@type': 'PostalAddress', addressLocality: 'Skopje', addressCountry: 'MK' },
      sameAs: ['https://facebook.com/examplestudio'],
    });
    const offers = json.makesOffer as { priceSpecification: Record<string, unknown> }[];
    expect(offers[1]!.priceSpecification).toEqual({ '@type': 'UnitPriceSpecification', minPrice: 150, priceCurrency: 'EUR', unitCode: 'MON', unitText: 'month' });
    expect(schemaDraft(business(), null, null)).not.toContain('sameAs');
  });

  it('builds an llms.txt draft that links known services to detected pages', () => {
    const text = llmsTxtDraft(business(), FACTS, siteAudit());
    expect(text).toContain('# Example Studio');
    expect(text).toContain('> Example Studio is a web design agency in Skopje, North Macedonia.');
    expect(text).toContain('- [Social media management](https://examplestudio.example/uslugi/social-media): from €150/month');
    expect(text).toContain('- Phone: 02 555 0100');
    expect(text).toContain('- Prices: https://examplestudio.example/ceni');
  });

  it('counts cited domains only for answers that did not name the business', () => {
    expect(
      sourcesWithoutYou(
        [a('perplexity', { citations: ['https://www.clutch.co/a', 'https://clutch.co/b'] }), named('perplexity'), a('openai', { ok: false, citations: ['https://x.test'] })],
        'examplestudio.example',
      ),
    ).toEqual([{ domain: 'clutch.co', count: 1 }]);
  });
});
