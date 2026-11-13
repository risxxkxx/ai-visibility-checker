import type { BusinessInput, SiteAudit } from '../src/lib/types.ts';

export function business(overrides: Partial<BusinessInput> = {}): BusinessInput {
  return {
    name: 'Example Studio',
    aliases: [],
    domain: 'examplestudio.example',
    category: 'web design agency',
    city: 'Skopje',
    country: 'North Macedonia',
    competitors: [],
    language: 'en',
    ...overrides,
  };
}

/** A complete, well-prepared site audit; override fields to create problems. */
export function siteAudit(overrides: Partial<SiteAudit> = {}): SiteAudit {
  return {
    version: 1,
    domain: 'examplestudio.example',
    finalUrl: 'https://examplestudio.example/',
    checkedAt: '2026-11-13T10:00:00.000Z',
    https: true,
    httpRedirectsToHttps: true,
    viewport: true,
    title: 'Example Studio | Web design in Skopje',
    metaDescription: 'Websites for small businesses in Skopje.',
    telLinks: 1,
    brandNames: [
      { source: 'title', value: 'Example Studio | Web design in Skopje' },
      { source: 'og:site_name', value: 'Example Studio' },
      { source: 'schema', value: 'Example Studio' },
    ],
    schema: {
      present: true,
      types: ['ProfessionalService', 'PostalAddress'],
      invalidBlocks: 0,
      name: 'Example Studio',
      alternateNames: [],
      telephone: '+389 2 555 0100',
      address: 'ul. Primer 1, Skopje, MK',
      priceRange: '€€',
      hasOffers: true,
      sameAs: ['https://facebook.com/examplestudio'],
    },
    llmsTxt: { state: 'present', status: 200, bytes: 400 },
    robots: { state: 'present', blockedAiBots: [] },
    sitemap: 'present',
    languages: { htmlLang: 'mk', hreflang: ['mk', 'en'], cyrillicShare: 0.8, hasMk: true, hasEn: true, switcherLinks: [] },
    services: {
      pages: [
        { url: 'https://examplestudio.example/uslugi/web-dizajn', text: 'Web design' },
        { url: 'https://examplestudio.example/uslugi/social-media', text: 'Social media' },
        { url: 'https://examplestudio.example/ceni', text: 'Prices' },
      ],
      sectionAnchors: 0,
      pricingPage: 'https://examplestudio.example/ceni',
    },
    phonesOnSite: ['+38925550100'],
    psi: null,
    psiStatus: 'not-configured',
    ...overrides,
  };
}
