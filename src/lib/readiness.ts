/**
 * Site readiness sub-score, 0-100, from the GEO website audit:
 *
 *   readiness = round(100 × Σ weight(passed checks) ÷ Σ weight(passed + failed checks))
 *
 * Checks that could not be evaluated ("unknown", e.g. llms.txt timed out) are left out of both
 * sums. It is kept separate from the visibility score on purpose: a well-prepared site can still
 * be invisible, and a famous business can be named with a bare site.
 */
import type { BusinessInput, KnownFacts, Localized, Readiness, ReadinessCheck, ReadinessId, SiteAudit } from './types.ts';
import { brandTokens } from './normalize.ts';
import { mentions } from './mention.ts';
import { samePhone } from './facts.ts';

export const READINESS_WEIGHTS: Record<ReadinessId, number> = {
  schema: 2,
  'schema-fields': 2,
  'llms-txt': 1,
  'ai-crawlers': 1,
  languages: 1,
  'service-pages': 1,
  'prices-published': 1,
  'name-consistency': 1,
  'phone-on-site': 0.5,
  https: 0.5,
  mobile: 0.5,
};

const L = (en: string, mk: string): Localized => ({ en, mk });

export type SchemaField = 'name' | 'telephone' | 'address' | 'prices' | 'sameAs';

export const SCHEMA_FIELD_LABELS: Record<SchemaField, Localized> = {
  name: L('name', 'име (name)'),
  telephone: L('telephone', 'телефон (telephone)'),
  address: L('address', 'адреса (address)'),
  prices: L('priceRange or offers', 'цени (priceRange или offers)'),
  sameAs: L('sameAs links to your profiles', 'sameAs линкови до профилите'),
};

export function missingSchemaFields(audit: SiteAudit): SchemaField[] {
  const s = audit.schema;
  const missing: SchemaField[] = [];
  if (!s.name) missing.push('name');
  if (!s.telephone) missing.push('telephone');
  if (!s.address) missing.push('address');
  if (!s.priceRange && !s.hasOffers) missing.push('prices');
  if (s.sameAs.length === 0) missing.push('sameAs');
  return missing;
}

const key = (name: string) =>
  brandTokens(name)
    .map((t) => t.key)
    .join('');

export function officialName(business: BusinessInput, facts: KnownFacts | null): string {
  return facts?.officialName.trim() || business.name.trim();
}

/** Brand names on the site that differ from the official name and allowed variants. */
export function inconsistentSiteNames(audit: SiteAudit, business: BusinessInput, facts: KnownFacts | null): string[] {
  const official = officialName(business, facts);
  const allowed = [official, business.name, ...business.aliases, ...(facts?.nameVariants ?? [])].filter((s) => s.trim());
  const allowedKeys = new Set(allowed.map(key));
  const out: string[] = [];
  for (const b of audit.brandNames) {
    if (b.source === 'schema:alternateName') continue;
    const ok =
      b.source === 'title'
        ? allowed.some((n) => mentions(b.value, { name: n }))
        : allowedKeys.has(key(b.value));
    if (!ok && !out.includes(b.value)) out.push(b.value);
  }
  return out;
}

function list(items: Localized[], lang: keyof Localized): string {
  return items.map((i) => i[lang]).join(', ');
}

export function computeReadiness(audit: SiteAudit | null, business: BusinessInput, facts: KnownFacts | null): Readiness {
  if (!audit) return { score: null, checks: [] };
  const checks: ReadinessCheck[] = [];
  const add = (id: ReadinessId, state: ReadinessCheck['state'], label: Localized, detail: Localized) =>
    checks.push({ id, state, weight: READINESS_WEIGHTS[id], label, detail });

  const s = audit.schema;
  add(
    'schema',
    s.present ? 'pass' : 'fail',
    L('Business schema (JSON-LD)', 'Schema за бизнисот (JSON-LD)'),
    s.present
      ? L(`Found: ${s.types.join(', ')}`, `Пронајдено: ${s.types.join(', ')}`)
      : L('No Organization or LocalBusiness JSON-LD on the home page', 'Нема Organization или LocalBusiness JSON-LD на почетната страница'),
  );
  const missing = missingSchemaFields(audit).map((f) => SCHEMA_FIELD_LABELS[f]);
  add(
    'schema-fields',
    s.present && missing.length === 0 ? 'pass' : 'fail',
    L('Schema has name, phone, address, prices, sameAs', 'Schema има име, телефон, адреса, цени, sameAs'),
    !s.present
      ? L('No business schema to check', 'Нема schema за проверка')
      : missing.length === 0
        ? L('All key fields present', 'Ги има сите важни полиња')
        : L(`Missing: ${list(missing, 'en')}`, `Недостасува: ${list(missing, 'mk')}`),
  );
  add(
    'llms-txt',
    audit.llmsTxt.state === 'present' ? 'pass' : audit.llmsTxt.state === 'missing' ? 'fail' : 'unknown',
    L('/llms.txt', '/llms.txt'),
    audit.llmsTxt.state === 'present'
      ? L(`Present (${audit.llmsTxt.bytes} bytes)`, `Постои (${audit.llmsTxt.bytes} бајти)`)
      : audit.llmsTxt.state === 'missing'
        ? L(`Not found (HTTP ${audit.llmsTxt.status ?? '–'})`, `Не постои (HTTP ${audit.llmsTxt.status ?? '–'})`)
        : L('Could not be checked', 'Не можеше да се провери'),
  );
  const blocked = audit.robots.blockedAiBots;
  add(
    'ai-crawlers',
    audit.robots.state === 'unknown' ? 'unknown' : blocked.length > 0 ? 'fail' : 'pass',
    L('AI crawlers allowed in robots.txt', 'robots.txt ги дозволува AI роботите'),
    blocked.length > 0
      ? L(`Blocked: ${blocked.join(', ')}`, `Блокирани: ${blocked.join(', ')}`)
      : audit.robots.state === 'missing'
        ? L('No robots.txt, so nothing is blocked', 'Нема robots.txt, значи ништо не е блокирано')
        : audit.robots.state === 'present'
          ? L('No AI crawler is blocked', 'Ниту еден AI робот не е блокиран')
          : L('Could not be checked', 'Не можеше да се провери'),
  );
  const lang = audit.languages;
  add(
    'languages',
    lang.hasMk && lang.hasEn ? 'pass' : 'fail',
    L('Macedonian and English content', 'Содржина на македонски и англиски'),
    lang.hasMk && lang.hasEn
      ? L(
          `Both found${lang.hreflang.length ? ` (hreflang: ${lang.hreflang.join(', ')})` : ''}`,
          `Има и двата${lang.hreflang.length ? ` (hreflang: ${lang.hreflang.join(', ')})` : ''}`,
        )
      : lang.hasMk
        ? L('Only Macedonian found (no English version or hreflang)', 'Само македонски (нема англиска верзија ни hreflang)')
        : lang.hasEn
          ? L('Only English found (no Macedonian version)', 'Само англиски (нема македонска верзија)')
          : L('Language could not be determined', 'Не може да се одреди јазикот'),
  );
  const servicePages = audit.services.pages.filter((p) => p.url !== audit.services.pricingPage);
  add(
    'service-pages',
    servicePages.length >= 2 ? 'pass' : 'fail',
    L('Separate pages per service', 'Посебна страница за секоја услуга'),
    servicePages.length >= 2
      ? L(`${servicePages.length} service pages linked`, `${servicePages.length} страници за услуги`)
      : audit.services.sectionAnchors > 0
        ? L('Services are sections of one page (#anchors), not separate pages', 'Услугите се делови од една страница (#), не посебни страници')
        : L(`${servicePages.length} service pages found in the links`, `Пронајдени ${servicePages.length} страници за услуги во линковите`),
  );
  const pricesOk = Boolean(audit.services.pricingPage || s.priceRange || s.hasOffers);
  add(
    'prices-published',
    pricesOk ? 'pass' : 'fail',
    L('Prices published', 'Објавени цени'),
    audit.services.pricingPage
      ? L(`Prices page: ${audit.services.pricingPage}`, `Страница со цени: ${audit.services.pricingPage}`)
      : pricesOk
        ? L('Prices in schema', 'Цени во schema')
        : L('No prices page linked and no prices in schema', 'Нема линк до цени ни цени во schema'),
  );
  const odd = inconsistentSiteNames(audit, business, facts);
  add(
    'name-consistency',
    odd.length === 0 ? 'pass' : 'fail',
    L('One brand name on the site', 'Едно име на брендот на сајтот'),
    odd.length === 0
      ? L(`Uses "${officialName(business, facts)}"`, `Се користи „${officialName(business, facts)}“`)
      : L(`Other names: ${odd.map((n) => `"${n}"`).join(', ')}`, `Други имиња: ${odd.map((n) => `„${n}“`).join(', ')}`),
  );
  const known = facts?.phones ?? [];
  const phoneOk = known.length > 0 ? audit.phonesOnSite.some((p) => known.some((k) => samePhone(k, p))) : audit.phonesOnSite.length > 0;
  add(
    'phone-on-site',
    phoneOk ? 'pass' : 'fail',
    L('Phone number on the home page', 'Телефон на почетната страница'),
    phoneOk
      ? L(`Found: ${audit.phonesOnSite.join(', ')}`, `Пронајден: ${audit.phonesOnSite.join(', ')}`)
      : audit.phonesOnSite.length > 0
        ? L(`Site shows ${audit.phonesOnSite.join(', ')}, not ${known.join(', ')}`, `Сајтот прикажува ${audit.phonesOnSite.join(', ')}, а не ${known.join(', ')}`)
        : L('No tel: link or schema telephone', 'Нема tel: линк ни телефон во schema'),
  );
  add(
    'https',
    audit.https && audit.httpRedirectsToHttps !== false ? 'pass' : 'fail',
    L('HTTPS', 'HTTPS'),
    !audit.https
      ? L('The site is served over plain http', 'Сајтот се отвора преку небезбедно http')
      : audit.httpRedirectsToHttps === false
        ? L('http:// does not redirect to https://', 'http:// не пренасочува кон https://')
        : L('Secure connection', 'Безбедна врска'),
  );
  add(
    'mobile',
    audit.viewport ? 'pass' : 'fail',
    L('Mobile-ready viewport', 'Прилагоден за мобилен'),
    audit.viewport ? L('width=device-width set', 'Поставено width=device-width') : L('No mobile viewport tag', 'Нема ознака за мобилен приказ'),
  );

  const counted = checks.filter((c) => c.state !== 'unknown');
  const total = counted.reduce((sum, c) => sum + c.weight, 0);
  const passed = counted.filter((c) => c.state === 'pass').reduce((sum, c) => sum + c.weight, 0);
  return { score: total === 0 ? null : Math.round((100 * passed) / total), checks };
}
