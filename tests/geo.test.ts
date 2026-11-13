import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockedAiBots,
  brandNames,
  buildSiteAudit,
  isBusinessType,
  languageSignals,
  llmsTxtState,
  robotsState,
  serviceLinks,
  sitemapState,
  summariseSchema,
  telLinks,
  visibleText,
} from '../server/geo.ts';

const html = readFileSync(new URL('./fixtures/geo-site.html', import.meta.url), 'utf8');
const NOW = new Date('2026-11-13T10:00:00Z');

describe('summariseSchema', () => {
  it('reads the business node inside @graph and lists missing fields as empty', () => {
    const s = summariseSchema(html);
    expect(s.present).toBe(true);
    expect(s.types).toEqual(expect.arrayContaining(['WebSite', 'ProfessionalService', 'PostalAddress']));
    expect(s.invalidBlocks).toBe(1);
    expect(s.name).toBe('Пример Студио');
    expect(s.alternateNames).toEqual(['Primer Studio']);
    expect(s.telephone).toBe('+389 70 123 456');
    expect(s.address).toBe('ул. Македонија 1, Скопје, MK');
    expect(s.priceRange).toBeNull();
    expect(s.hasOffers).toBe(false);
    expect(s.sameAs).toEqual([]);
  });

  it('finds priceRange, offers and sameAs, and ignores non-business types', () => {
    const page = `<script type="application/ld+json">[
      {"@type":"WebPage","name":"Home"},
      {"@type":"https://schema.org/LocalBusiness","name":"X","priceRange":"€€","makesOffer":[{"@type":"Offer"}],
       "sameAs":["https://facebook.com/x","javascript:alert(1)","https://instagram.com/x"]}]</script>`;
    const s = summariseSchema(page);
    expect(s).toMatchObject({ present: true, name: 'X', priceRange: '€€', hasOffers: true });
    expect(s.sameAs).toEqual(['https://facebook.com/x', 'https://instagram.com/x']);
    expect(summariseSchema('<script type="application/ld+json">{"@type":"WebSite","name":"Y"}</script>').present).toBe(false);
  });

  it('ignores JSON-LD inside HTML comments and handles no schema at all', () => {
    expect(summariseSchema('<!-- <script type="application/ld+json">{"@type":"Organization"}</script> -->').present).toBe(false);
    expect(summariseSchema('<p>hi</p>')).toMatchObject({ present: false, types: [], invalidBlocks: 0, name: null });
  });

  it('classifies business types', () => {
    expect(isBusinessType('ProfessionalService')).toBe(true);
    expect(isBusinessType('AutoBodyShop')).toBe(true);
    expect(isBusinessType('TravelAgency')).toBe(true);
    expect(isBusinessType('Service')).toBe(false);
    expect(isBusinessType('WebSite')).toBe(false);
  });
});

describe('brand names, text and links', () => {
  it('collects the names the site shows', () => {
    const names = brandNames(html, 'Пример Студио | Веб дизајн и брендирање, Скопје', summariseSchema(html));
    expect(names).toEqual([
      { source: 'title', value: 'Пример Студио | Веб дизајн и брендирање, Скопје' },
      { source: 'og:site_name', value: 'Primer Studio' },
      { source: 'schema', value: 'Пример Студио' },
      { source: 'schema:alternateName', value: 'Primer Studio' },
    ]);
  });

  it('extracts visible text without scripts or comments', () => {
    const text = visibleText(html);
    expect(text).toContain('Веб-страници што носат клиенти');
    expect(text).not.toContain('document.write');
    expect(text).not.toContain('стара');
  });

  it('detects service pages, the pricing page and in-page service sections', () => {
    const s = serviceLinks(html, 'https://primer.example/');
    expect(s.pages.map((p) => p.url)).toEqual([
      'https://primer.example/uslugi/web-dizajn/',
      'https://www.primer.example/uslugi/brending',
      'https://primer.example/ceni',
    ]);
    expect(s.pricingPage).toBe('https://primer.example/ceni');
    expect(s.sectionAnchors).toBe(1);
  });

  it('treats a one-page site with only #anchors as sections, not pages', () => {
    const s = serviceLinks('<a href="#services">Services</a><a href="/#pricing">Pricing</a><a href="/about">About</a>', 'https://a.example/');
    expect(s).toEqual({ pages: [], sectionAnchors: 2, pricingPage: null });
  });

  it('reads tel: links', () => {
    expect(telLinks(html)).toEqual(['+38970123456']);
  });
});

describe('languageSignals', () => {
  it('sees Macedonian and English from lang, hreflang and the switcher', () => {
    const l = languageSignals(html, 'mk', visibleText(html));
    expect(l.hasMk).toBe(true);
    expect(l.hasEn).toBe(true);
    expect(l.hreflang).toEqual(['mk', 'en']);
    expect(l.cyrillicShare).toBeGreaterThan(0.8);
    expect(l.switcherLinks).toEqual(['EN → /en/']);
  });

  it('reports a Macedonian-only site', () => {
    const page = '<html lang="mk"><p>Изработка на веб-страници во Скопје за мали бизниси и занаетчии.</p></html>';
    const l = languageSignals(page, 'mk', visibleText(page));
    expect(l).toMatchObject({ hasMk: true, hasEn: false, hreflang: [], switcherLinks: [] });
  });

  it('reports an English-only site', () => {
    const page =
      '<p>We build websites for small businesses. Our team works with you and your customers, and we offer services for the web.</p>';
    const l = languageSignals(page, 'en', visibleText(page));
    expect(l).toMatchObject({ hasMk: false, hasEn: true });
  });
});

describe('side files', () => {
  it('llms.txt: present only for real text files', () => {
    expect(llmsTxtState({ status: 200, contentType: 'text/plain', body: '# Primer Studio\n> Web design in Skopje.' }).state).toBe('present');
    expect(llmsTxtState({ status: 200, contentType: 'text/html', body: '<!doctype html><html>404</html>' }).state).toBe('missing');
    expect(llmsTxtState({ status: 404, contentType: 'text/plain', body: 'Not found' })).toMatchObject({ state: 'missing', status: 404 });
    expect(llmsTxtState(null)).toEqual({ state: 'unknown', status: null, bytes: 0 });
  });

  it('robots.txt: finds AI crawlers that are blocked', () => {
    const robots = `User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\nAllow: /\n`;
    expect(blockedAiBots(robots)).toEqual(['GPTBot', 'CCBot']);
    expect(blockedAiBots('User-agent: *\nDisallow: /')).toHaveLength(10);
    expect(blockedAiBots('User-agent: *\nDisallow:')).toEqual([]);
    expect(robotsState({ status: 404, contentType: 'text/html', body: null })).toEqual({ state: 'missing', blockedAiBots: [] });
    expect(robotsState(null).state).toBe('unknown');
  });

  it('sitemap: requires XML', () => {
    expect(sitemapState({ status: 200, contentType: 'application/xml', body: '<urlset/>' })).toBe('present');
    expect(sitemapState({ status: 200, contentType: 'text/html', body: '<html>' })).toBe('missing');
    expect(sitemapState(null)).toBe('unknown');
  });
});

describe('buildSiteAudit', () => {
  it('assembles everything into one SiteAudit', () => {
    const audit = buildSiteAudit({
      domain: 'primer.example',
      html,
      finalUrl: 'https://primer.example/',
      httpRedirectsToHttps: true,
      llms: { status: 404, contentType: 'text/html', body: '<html></html>' },
      robots: { status: 200, contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
      sitemap: { status: 200, contentType: 'application/xml', body: '<urlset/>' },
      psi: null,
      psiStatus: 'not-configured',
      now: NOW,
    });
    expect(audit).toMatchObject({
      version: 1,
      domain: 'primer.example',
      https: true,
      viewport: true,
      telLinks: 1,
      llmsTxt: { state: 'missing' },
      robots: { state: 'present', blockedAiBots: [] },
      sitemap: 'present',
      psi: null,
      psiStatus: 'not-configured',
      checkedAt: '2026-11-13T10:00:00.000Z',
    });
    expect(audit.phonesOnSite).toEqual(['+38970123456', '+389 70 123 456']);
    expect(audit.services.pages).toHaveLength(3);
  });
});
