import { describe, expect, it } from 'vitest';
import { computeReadiness, inconsistentSiteNames, missingSchemaFields, READINESS_WEIGHTS } from '../src/lib/readiness.ts';
import type { KnownFacts } from '../src/lib/types.ts';
import { business, siteAudit } from './fixtures.ts';

const facts: KnownFacts = { officialName: 'Example Studio', nameVariants: [], phones: ['02 555 0100'], prices: [], city: '', address: '' };

describe('computeReadiness', () => {
  it('is null without an audit', () => {
    expect(computeReadiness(null, business(), null)).toEqual({ score: null, checks: [] });
  });

  it('scores a fully prepared site 100', () => {
    const r = computeReadiness(siteAudit(), business(), facts);
    expect(r.score).toBe(100);
    expect(r.checks.every((c) => c.state === 'pass')).toBe(true);
    expect(r.checks).toHaveLength(Object.keys(READINESS_WEIGHTS).length);
  });

  it('weights failures and leaves unknown checks out of the denominator', () => {
    // Weights sum to 11.5. Fails: schema-fields (2) and llms.txt (1). Unknown: ai-crawlers (1), so 10.5 are counted.
    const audit = siteAudit({
      schema: { ...siteAudit().schema, sameAs: [] },
      llmsTxt: { state: 'missing', status: 404, bytes: 0 },
      robots: { state: 'unknown', blockedAiBots: [] },
    });
    const r = computeReadiness(audit, business(), facts);
    expect(Object.values(READINESS_WEIGHTS).reduce((x, y) => x + y, 0)).toBe(11.5);
    expect(r.score).toBe(Math.round((100 * (10.5 - 3)) / 10.5));
    expect(r.checks.find((c) => c.id === 'schema-fields')!.detail.en).toBe('Missing: sameAs links to your profiles');
    expect(r.checks.find((c) => c.id === 'schema-fields')!.detail.mk).toBe('Недостасува: sameAs линкови до профилите');
    expect(r.checks.find((c) => c.id === 'ai-crawlers')!.state).toBe('unknown');
  });

  it('fails checks for a bare site', () => {
    const audit = siteAudit({
      https: false,
      httpRedirectsToHttps: null,
      viewport: false,
      brandNames: [{ source: 'title', value: 'Home' }],
      schema: { present: false, types: [], invalidBlocks: 0, name: null, alternateNames: [], telephone: null, address: null, priceRange: null, hasOffers: false, sameAs: [] },
      llmsTxt: { state: 'missing', status: 404, bytes: 0 },
      robots: { state: 'present', blockedAiBots: ['GPTBot'] },
      languages: { htmlLang: '', hreflang: [], cyrillicShare: 1, hasMk: true, hasEn: false, switcherLinks: [] },
      services: { pages: [], sectionAnchors: 0, pricingPage: null },
      phonesOnSite: [],
    });
    const r = computeReadiness(audit, business(), facts);
    expect(r.score).toBe(0);
    expect(r.checks.find((c) => c.id === 'name-consistency')!.detail.en).toBe('Other names: "Home"');
    expect(r.checks.find((c) => c.id === 'languages')!.detail.mk).toContain('Само македонски');
  });

  it('checks the known phone against the phones on the site', () => {
    const r = computeReadiness(siteAudit({ phonesOnSite: ['070 111 222'] }), business(), facts);
    const phone = r.checks.find((c) => c.id === 'phone-on-site')!;
    expect(phone.state).toBe('fail');
    expect(phone.detail.en).toBe('Site shows 070 111 222, not 02 555 0100');
  });
});

describe('helpers', () => {
  it('lists missing schema fields', () => {
    expect(missingSchemaFields(siteAudit({ schema: { ...siteAudit().schema, telephone: null, priceRange: null, hasOffers: false } }))).toEqual([
      'telephone',
      'prices',
    ]);
  });

  it('accepts the official name, aliases and allowed variants, and the name inside the title', () => {
    const audit = siteAudit({
      brandNames: [
        { source: 'title', value: 'Егзампл Студио – веб дизајн' },
        { source: 'og:site_name', value: 'Example Studio DOOEL' },
        { source: 'schema', value: 'ES Agency' },
        { source: 'schema:alternateName', value: 'Anything' },
      ],
    });
    expect(inconsistentSiteNames(audit, business({ aliases: ['Егзампл Студио'] }), null)).toEqual(['ES Agency']);
    expect(inconsistentSiteNames(audit, business({ aliases: ['Егзампл Студио'] }), { ...facts, nameVariants: ['ES Agency'] })).toEqual([]);
  });
});
