/**
 * GEO (generative engine optimisation) checks on top of the ported HTML audit.
 *
 * Pure functions: the audit function fetches the pages through the SSRF guard and passes
 * the HTML and side-check results in here. Everything is regex/attribute based (no DOM),
 * so results are heuristics; each field keeps the raw value it was based on.
 */
import { analyzeHtml, decodeEntities, findTags, stripComments } from './audit/audit.mjs';
import type { PsiResult } from './audit/psi.mjs';
import type {
  BrandNameSource,
  CheckState,
  LanguageSignals,
  PsiSummary,
  SchemaSummary,
  ServiceLink,
  SiteAudit,
} from '../src/lib/types.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const clean = (v: unknown, max = 200): string =>
  typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim().slice(0, max) : '';

// ---------- JSON-LD ----------

/** LocalBusiness subtypes that do not end in a generic suffix. */
const BUSINESS_TYPES = new Set([
  'Organization', 'LocalBusiness', 'Corporation', 'NGO', 'OnlineBusiness', 'ProfessionalService', 'Dentist',
  'Physician', 'Pharmacy', 'Optician', 'Attorney', 'Notary', 'Electrician', 'Plumber', 'Locksmith', 'HousePainter',
  'RoofingContractor', 'GeneralContractor', 'MovingCompany', 'Restaurant', 'Bakery', 'BarOrPub', 'Winery',
  'CafeOrCoffeeShop', 'Hotel', 'Hostel', 'Motel', 'Florist', 'BeautySalon', 'HairSalon', 'NailSalon', 'DaySpa',
  'ExerciseGym', 'AutoRepair', 'AutoDealer', 'AutoWash', 'AutoRental', 'AutoBodyShop', 'GasStation', 'School',
  'EducationalOrganization', 'MedicalClinic', 'VeterinaryCare', 'RealEstateAgent', 'TravelAgency', 'InsuranceAgency',
  'AccountingService', 'LegalService', 'FinancialService', 'DryCleaningOrLaundry', 'EmploymentAgency',
]);
const BUSINESS_SUFFIX_RE = /(Business|Store|Organization|Corporation|Agency|Restaurant|Clinic|Contractor|Salon|Dealer)$/;

export function isBusinessType(type: string): boolean {
  return BUSINESS_TYPES.has(type) || BUSINESS_SUFFIX_RE.test(type);
}

function typesOf(node: Json): string[] {
  return asArray(node['@type'])
    .filter((t): t is string => typeof t === 'string' && t.length < 80)
    .map((t) => t.replace(/^https?:\/\/schema\.org\//i, ''));
}

function addressText(value: unknown): string {
  if (typeof value === 'string') return clean(value);
  if (!isObj(value)) return '';
  const parts = ['streetAddress', 'addressLocality', 'postalCode', 'addressRegion', 'addressCountry'].map((k) => {
    const v = value[k];
    return isObj(v) ? clean(v.name) : clean(v);
  });
  return parts.filter(Boolean).join(', ').slice(0, 200);
}

function collectNodes(node: unknown, out: Json[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.slice(0, 50).forEach((n) => collectNodes(n, out, depth + 1));
    return;
  }
  out.push(node as Json);
  for (const [key, value] of Object.entries(node)) {
    if (key !== '@type' && value && typeof value === 'object') collectNodes(value, out, depth + 1);
  }
}

/** Reads every JSON-LD block and summarises the business (Organization/LocalBusiness) nodes. */
export function summariseSchema(html: string): SchemaSummary {
  const nodes: Json[] = [];
  let invalidBlocks = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of stripComments(html).matchAll(re)) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(m[1] ?? '')) continue;
    try {
      collectNodes(JSON.parse((m[2] ?? '').trim()), nodes);
    } catch {
      invalidBlocks += 1;
    }
  }
  const types = [...new Set(nodes.flatMap(typesOf))].slice(0, 20);
  const business = nodes.filter((n) => typesOf(n).some(isBusinessType));
  const first = (pick: (n: Json) => string): string | null => {
    for (const n of business) {
      const v = pick(n);
      if (v) return v;
    }
    return null;
  };
  const alternateNames = [
    ...new Set(business.flatMap((n) => asArray(n.alternateName).map((v) => clean(v, 100)).filter(Boolean))),
  ].slice(0, 5);
  const sameAs = [
    ...new Set(
      business.flatMap((n) => asArray(n.sameAs).map((v) => clean(v, 300)).filter((v) => /^https?:\/\//i.test(v))),
    ),
  ].slice(0, 15);
  return {
    present: business.length > 0,
    types,
    invalidBlocks,
    name: first((n) => clean(n.name, 120)),
    alternateNames,
    telephone: first((n) => clean(n.telephone, 40)),
    address: first((n) => addressText(n.address)),
    priceRange: first((n) => clean(n.priceRange, 60)),
    hasOffers: business.some((n) => ['makesOffer', 'offers', 'hasOfferCatalog'].some((k) => n[k] !== undefined && n[k] !== null)),
    sameAs,
  };
}

// ---------- names, text, links ----------

function metaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase();
  const tag = findTags(html, 'meta').find(
    (m) => (m.attrs.name ?? '').toLowerCase() === wanted || (m.attrs.property ?? '').toLowerCase() === wanted,
  );
  const value = tag ? clean(tag.attrs.content ?? '', 150) : '';
  return value || null;
}

/** The brand names a visitor (or a crawler) sees on the site, for name-consistency checks. */
export function brandNames(html: string, title: string | null, schema: SchemaSummary): BrandNameSource[] {
  const out: BrandNameSource[] = [];
  const push = (source: BrandNameSource['source'], value: string | null) => {
    if (value && !out.some((o) => o.source === source && o.value === value)) out.push({ source, value: value.slice(0, 150) });
  };
  push('title', title);
  push('og:site_name', metaContent(html, 'og:site_name'));
  push('application-name', metaContent(html, 'application-name'));
  push('schema', schema.name);
  for (const alt of schema.alternateNames) push('schema:alternateName', alt);
  return out;
}

function stripBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  return out;
}

export function visibleText(html: string): string {
  return decodeEntities(
    stripBlocks(stripComments(html), ['script', 'style', 'noscript', 'template', 'svg']).replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

interface Anchor {
  href: string;
  text: string;
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const body = stripBlocks(stripComments(html), ['script', 'style', 'template']);
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] ?? '');
    const href = decodeEntities(hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '').trim();
    const label = /\b(?:aria-label|title)\s*=\s*"([^"]*)"/i.exec(m[1] ?? '');
    const text = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || clean(label?.[1] ?? '');
    if (href) out.push({ href, text: text.slice(0, 80) });
    if (out.length >= 500) break;
  }
  return out;
}

const LANG_TEXT: Record<string, 'mk' | 'en'> = {
  en: 'en', eng: 'en', english: 'en', англиски: 'en', angliski: 'en',
  mk: 'mk', мк: 'mk', mkd: 'mk', мкд: 'mk', македонски: 'mk', makedonski: 'mk',
};

/** Macedonian and English content signals: html lang, hreflang, script share, language switcher links. */
export function languageSignals(html: string, htmlLang: string, text: string): LanguageSignals {
  const hreflang = [
    ...new Set(
      findTags(html, 'link')
        .filter((l) => (l.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('alternate') && l.attrs.hreflang)
        .map((l) => (l.attrs.hreflang ?? '').toLowerCase().trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);

  const letters = text.match(/\p{L}/gu) ?? [];
  const cyr = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  const cyrillicShare = letters.length === 0 ? 0 : Math.round((cyr / letters.length) * 100) / 100;
  const englishWords = (text.toLowerCase().match(/\b(the|and|for|with|our|your|we|you|about|contact|services)\b/g) ?? [])
    .length;

  const switcherLinks: string[] = [];
  let linkMk = false;
  let linkEn = false;
  for (const a of anchors(html)) {
    const byText = LANG_TEXT[a.text.toLowerCase().replace(/[^\p{L}]/gu, '')];
    const byPath = /(?:^|\/)(en|mk)(?:\/|$|\?|#)|[?&](?:lang|hl)=(en|mk)\b/i.exec(a.href);
    const lang = byText ?? ((byPath?.[1] ?? byPath?.[2])?.toLowerCase() as 'en' | 'mk' | undefined);
    if (!lang) continue;
    if (lang === 'mk') linkMk = true;
    else linkEn = true;
    if (switcherLinks.length < 6) switcherLinks.push(`${a.text || lang.toUpperCase()} → ${a.href.slice(0, 120)}`);
  }

  const lang = htmlLang.toLowerCase();
  const hasMk = lang.startsWith('mk') || hreflang.some((h) => h.startsWith('mk')) || cyrillicShare >= 0.3 || linkMk;
  const hasEn =
    lang.startsWith('en') || hreflang.some((h) => h.startsWith('en')) || (cyrillicShare <= 0.7 && englishWords >= 8) || linkEn;
  return { htmlLang, hreflang, cyrillicShare, hasMk, hasEn, switcherLinks };
}

const SERVICE_RE =
  /uslug|услуг|servic|web-?dizajn|веб-?дизајн|web-?design|webdesign|izrabotka|изработка|brand|бренд|seo|marketing|маркетинг|social|социјал|e-?commerce|online-?prodavnic|онлајн|development|razvoj|развој|hosting|хостинг|odrzuvanje|održavanje|одржување|logo|лого|fotograf|фотограф|video|видео|ceni|цени|cenovnik|ценовник|pricing|prices|price|paketi|пакети|packages/i;
const PRICING_RE = /ceni|цени|cenovnik|ценовник|pricing|prices|price|paketi|пакети|packages|tarif|тариф/i;

/** Same-site links that look like service or pricing pages, and in-page service anchors. */
export function serviceLinks(html: string, pageUrl: string): SiteAudit['services'] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return { pages: [], sectionAnchors: 0, pricingPage: null };
  }
  const site = base.hostname.replace(/^www\./, '');
  const pages: ServiceLink[] = [];
  const seen = new Set<string>();
  let sectionAnchors = 0;
  let pricingPage: string | null = null;

  for (const a of anchors(html)) {
    if (/^(mailto|tel|javascript|data):/i.test(a.href)) continue;
    if (a.href.startsWith('#')) {
      if (SERVICE_RE.test(a.href) || SERVICE_RE.test(a.text)) sectionAnchors += 1;
      continue;
    }
    let url: URL;
    try {
      url = new URL(a.href, base);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, '') !== site || !/^https?:$/.test(url.protocol)) continue;
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the encoded path
    }
    if (path === '/' || path === '') {
      if (url.hash && (SERVICE_RE.test(url.hash) || SERVICE_RE.test(a.text))) sectionAnchors += 1;
      continue;
    }
    if (/\.(jpe?g|png|gif|svg|webp|pdf|zip|css|js)$/i.test(path)) continue;
    if (!SERVICE_RE.test(path) && !SERVICE_RE.test(a.text)) continue;
    const key = path.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const href = `${url.origin}${url.pathname}`;
    if (!pricingPage && (PRICING_RE.test(path) || PRICING_RE.test(a.text))) pricingPage = href;
    if (pages.length < 15) pages.push({ url: href, text: a.text });
  }
  return { pages, sectionAnchors, pricingPage };
}

export function telLinks(html: string): string[] {
  return [
    ...new Set(
      findTags(stripBlocks(stripComments(html), ['script', 'template']), 'a')
        .map((a) => a.attrs.href ?? '')
        .filter((h) => /^\s*tel:/i.test(h))
        .map((h) => h.replace(/^\s*tel:/i, '').trim().slice(0, 40)),
    ),
  ];
}

// ---------- side files ----------

export interface SideFetch {
  status: number;
  contentType: string;
  body: string | null;
}

/** /llms.txt counts as present when it is a 200 plain-text (not HTML) file with some content. */
export function llmsTxtState(res: SideFetch | null): SiteAudit['llmsTxt'] {
  if (!res) return { state: 'unknown', status: null, bytes: 0 };
  const body = res.body ?? '';
  const isHtml = /text\/html/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(body);
  const ok = res.status === 200 && !isHtml && body.trim().length >= 20;
  return { state: ok ? 'present' : 'missing', status: res.status, bytes: new TextEncoder().encode(body).length };
}

/** AI crawlers commonly blocked in robots.txt. Google-Extended controls Gemini training/grounding use. */
export const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
  'Googlebot',
  'Bingbot',
  'CCBot',
] as const;

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/).slice(0, 2000)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Bots from AI_BOTS that are told not to crawl the whole site (Disallow: / without Allow: /). */
export function blockedAiBots(robotsText: string): string[] {
  const groups = parseRobots(robotsText);
  const blocksAll = (g: RobotsGroup) =>
    g.rules.some((r) => !r.allow && (r.path === '/' || r.path === '/*')) && !g.rules.some((r) => r.allow && (r.path === '/' || r.path === '/*'));
  return AI_BOTS.filter((bot) => {
    const specific = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
    const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
    return applicable.some(blocksAll);
  });
}

export function robotsState(res: SideFetch | null): SiteAudit['robots'] {
  if (!res) return { state: 'unknown', blockedAiBots: [] };
  const isHtml = /text\/html/i.test(res.contentType);
  if (res.status !== 200 || res.body === null || isHtml) return { state: 'missing', blockedAiBots: [] };
  return { state: 'present', blockedAiBots: blockedAiBots(res.body) };
}

export function sitemapState(res: SideFetch | null): CheckState {
  if (!res) return 'unknown';
  const body = (res.body ?? '').trimStart().slice(0, 300);
  const looksXml = /xml/i.test(res.contentType) || /^(<\?xml|<urlset|<sitemapindex)/i.test(body);
  return res.status === 200 && looksXml && !/text\/html/i.test(res.contentType) ? 'present' : 'missing';
}

export function psiSummary(psi: PsiResult | null): PsiSummary | null {
  if (!psi) return null;
  return {
    performance: psi.categories.performance,
    seo: psi.categories.seo,
    accessibility: psi.categories.accessibility,
    bestPractices: psi.categories['best-practices'],
    lcpMs: psi.metrics.lcpMs,
    cls: psi.metrics.cls,
    tbtMs: psi.metrics.tbtMs,
  };
}

// ---------- assembly ----------

export interface GeoAuditInput {
  domain: string;
  html: string;
  finalUrl: string;
  bytes?: number;
  truncated?: boolean;
  httpRedirectsToHttps: boolean | null;
  llms: SideFetch | null;
  robots: SideFetch | null;
  sitemap: SideFetch | null;
  psi: PsiResult | null;
  psiStatus: SiteAudit['psiStatus'];
  now: Date;
}

export function buildSiteAudit(input: GeoAuditInput): SiteAudit {
  const facts = analyzeHtml(input.html, {
    finalUrl: input.finalUrl,
    byteLength: input.bytes,
    truncated: input.truncated,
    now: input.now,
  });
  const schema = summariseSchema(input.html);
  const text = visibleText(input.html);
  const phones = [...telLinks(input.html)];
  if (schema.telephone && !phones.includes(schema.telephone)) phones.push(schema.telephone);
  return {
    version: 1,
    domain: input.domain,
    finalUrl: input.finalUrl,
    checkedAt: input.now.toISOString(),
    https: facts.isHttps,
    httpRedirectsToHttps: input.httpRedirectsToHttps,
    viewport: facts.viewport.deviceWidth,
    title: facts.title?.text ?? null,
    metaDescription: facts.metaDescription?.text ?? null,
    telLinks: facts.telLinks,
    brandNames: brandNames(input.html, facts.title?.text ?? null, schema),
    schema,
    llmsTxt: llmsTxtState(input.llms),
    robots: robotsState(input.robots),
    sitemap: sitemapState(input.sitemap),
    languages: languageSignals(input.html, facts.lang, text),
    services: serviceLinks(input.html, input.finalUrl),
    phonesOnSite: phones.slice(0, 6),
    psi: psiSummary(input.psi),
    psiStatus: input.psiStatus,
  };
}
