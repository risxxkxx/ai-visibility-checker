/**
 * Rule-based recommendations, in English and Macedonian. No LLM is involved: each rule looks at
 * this run's evidence (visibility results, website audit, fact check, cited sources), decides
 * whether its item applies, at what priority, whether it is already done, and writes the "why"
 * from that evidence. Steps come from a fixed catalogue, filled in with the business's own facts.
 */
import type {
  AnswerAnalysis,
  BusinessInput,
  EngineId,
  FactCheck,
  KnownFacts,
  Localized,
  Priority,
  Recommendation,
  RecommendationId,
  ScoreBreakdown,
  ShareOfVoiceRow,
  SiteAudit,
} from './types.ts';
import { ENGINE_LABELS } from './types.ts';
import { foldText, hostMatchesDomain, hostOf, normalizeDomain } from './normalize.ts';
import { describeWrongClaim, formatPriceFact, labelMatches, samePhone } from './facts.ts';
import { inconsistentSiteNames, missingSchemaFields, officialName, SCHEMA_FIELD_LABELS } from './readiness.ts';

const L = (en: string, mk: string): Localized => ({ en, mk });

export const TITLES: Record<RecommendationId, Localized> = {
  'fix-wrong-facts': L('Correct the facts AI gets wrong about you', 'Исправете ги погрешните податоци што AI ги кажува за вас'),
  'google-business-profile': L('Claim and complete your Google Business Profile', 'Преземете го и пополнете го профилот на Google Business Profile'),
  'schema-localbusiness': L('Add LocalBusiness structured data (schema.org)', 'Додајте структурирани податоци LocalBusiness (schema.org)'),
  'consistent-nap': L('Use one name, address and phone everywhere', 'Користете исто име, адреса и телефон насекаде'),
  'ai-crawlers': L('Let AI crawlers read your site', 'Дозволете им на AI роботите да го читаат сајтот'),
  reviews: L('Collect more recent, detailed reviews', 'Соберете повеќе свежи и детални рецензии'),
  'service-pages': L('Publish one clear page per service', 'Направете посебна страница за секоја услуга'),
  'directory-citations': L('Get listed where AI assistants look', 'Бидете присутни таму каде што гледаат AI асистентите'),
  'local-language-content': L('Publish content in Macedonian and English', 'Објавете содржина на македонски и на англиски'),
  'llms-txt': L('Add an llms.txt file', 'Додајте датотека llms.txt'),
  bing: L('Set up Bing Webmaster Tools and Bing Places (for Copilot)', 'Поставете Bing Webmaster Tools и Bing Places (за Copilot)'),
  'page-speed': L('Fix mobile and speed problems on the site', 'Поправете ги проблемите со брзината и мобилниот приказ'),
};

const ORDER: RecommendationId[] = Object.keys(TITLES) as RecommendationId[];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export interface RecommendationInput {
  business: BusinessInput;
  analyses: AnswerAnalysis[];
  score: ScoreBreakdown;
  shareOfVoice: ShareOfVoiceRow[];
  topCitedDomains: { domain: string; count: number }[];
  audit?: SiteAudit | null;
  /** Why there is no audit, when there is none ("off", "failed", "no-domain"). */
  auditStatus?: string;
  factCheck?: FactCheck | null;
  facts?: KnownFacts | null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const r1 = (n: number) => String(Math.round(n * 10) / 10);
const engines = (ids: EngineId[]) => ids.map((e) => ENGINE_LABELS[e]).join(', ');
const quote = (s: string) => L(`"${s}"`, `„${s}“`);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname) || '/';
  } catch {
    return url;
  }
}

/** Plain-text answer counts per cited domain where the business was not named. */
export function sourcesWithoutYou(analyses: AnswerAnalysis[], ownDomain: string): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of analyses) {
    if (!a.ok || a.mentioned) continue;
    const seen = new Set<string>();
    for (const url of a.citations) {
      const host = hostOf(url);
      if (!host || seen.has(host) || (ownDomain && hostMatchesDomain(host, ownDomain))) continue;
      seen.add(host);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 6);
}

/** Does a known price item have a matching service page (by words in its URL or link text, EN or MK)? */
function pageFor(label: string, audit: SiteAudit | null): string | null {
  if (!audit || !label.trim()) return null;
  const hit = audit.services.pages.find((p) => p.url !== audit.services.pricingPage && labelMatches(label, `${pathOf(p.url).replace(/[-_/]+/g, ' ')} ${p.text}`));
  return hit?.url ?? null;
}

function countryCode(country: string): string | null {
  const c = foldText(country);
  if (/makedon|macedon|^mk$/.test(c)) return 'MK';
  return null;
}

/** JSON-LD draft from what the owner entered and what the audit found. Never invents URLs. */
export function schemaDraft(business: BusinessInput, facts: KnownFacts | null, audit: SiteAudit | null): string {
  const domain = normalizeDomain(business.domain);
  const name = officialName(business, facts);
  const alternate = [...new Set([...business.aliases, ...(facts?.nameVariants ?? [])].filter((n) => n.trim() && n !== name))];
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name,
  };
  if (alternate.length) data.alternateName = alternate;
  if (domain) data.url = `https://${domain}/`;
  const phone = facts?.phones[0] ?? audit?.schema.telephone ?? audit?.phonesOnSite[0];
  if (phone) data.telephone = phone;
  const city = facts?.city.trim() || business.city.trim();
  const address: Record<string, string> = { '@type': 'PostalAddress' };
  if (facts?.address.trim()) address.streetAddress = facts.address.trim();
  if (city) address.addressLocality = city;
  const cc = countryCode(business.country);
  if (cc) address.addressCountry = cc;
  if (Object.keys(address).length > 1) data.address = address;
  if (city) data.areaServed = city;
  const prices = facts?.prices ?? [];
  if (prices.length) {
    data.makesOffer = prices.map((p) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: p.label || 'Service' },
      priceSpecification: {
        '@type': p.perMonth ? 'UnitPriceSpecification' : 'PriceSpecification',
        minPrice: p.amount,
        priceCurrency: p.currency,
        ...(p.perMonth ? { unitCode: 'MON', unitText: 'month' } : {}),
      },
    }));
  }
  if (audit?.schema.sameAs.length) data.sameAs = audit.schema.sameAs;
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

/** llms.txt draft (markdown) from the business details, known prices and detected service pages. */
export function llmsTxtDraft(business: BusinessInput, facts: KnownFacts | null, audit: SiteAudit | null): string {
  const domain = normalizeDomain(business.domain);
  const name = officialName(business, facts);
  const city = facts?.city.trim() || business.city.trim();
  const where = [city, business.country.trim()].filter(Boolean).join(', ');
  const alternate = [...new Set([...business.aliases, ...(facts?.nameVariants ?? [])].filter((n) => n.trim() && n !== name))];
  const home = domain ? `https://${domain}/` : '';
  const lines = [`# ${name}`, '', `> ${name} is a ${business.category.trim()}${where ? ` in ${where}` : ''}.${alternate.length ? ` Also written as ${alternate.join(', ')}.` : ''}`, ''];
  const services: string[] = [];
  for (const p of facts?.prices ?? []) {
    const url = pageFor(p.label, audit) ?? home;
    const label = p.label || 'Service';
    services.push(`- ${url ? `[${label}](${url})` : label}: ${formatPriceFact(p).en}`);
  }
  if (services.length === 0) {
    for (const p of audit?.services.pages.slice(0, 8) ?? []) services.push(`- [${p.text || pathOf(p.url)}](${p.url})`);
  }
  if (services.length) lines.push('## Services', '', ...services, '');
  const contact: string[] = [];
  if (home) contact.push(`- Website: ${home}`);
  if (facts?.phones.length) contact.push(`- Phone: ${facts.phones.join(', ')}`);
  if (facts?.address.trim()) contact.push(`- Address: ${facts.address.trim()}${city ? `, ${city}` : ''}`);
  if (audit?.services.pricingPage) contact.push(`- Prices: ${audit.services.pricingPage}`);
  if (contact.length) lines.push('## Contact', '', ...contact, '');
  return lines.join('\n').trimEnd() + '\n';
}

export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const { business, analyses, score, shareOfVoice } = input;
  const audit = input.audit ?? null;
  const facts = input.facts ?? null;
  const factCheck = input.factCheck ?? null;
  const answered = analyses.filter((a) => a.ok);
  if (answered.length === 0) return [];

  // Only used in sentences about the audit, which always has a domain.
  const site = audit?.domain || normalizeDomain(business.domain);
  const official = officialName(business, facts);
  const m = score.mentionRate;
  const named = L(
    `Named in ${score.mentionedCount} of ${score.answered} answers (${pct(m)}).`,
    `Спомнати сте во ${score.mentionedCount} од ${score.answered} одговори (${pct(m)}).`,
  );
  const notAudited =
    input.auditStatus === 'failed'
      ? L('The website audit failed, so this is based on the AI answers only.', 'Проверката на сајтот не успеа, па ова се заснова само на одговорите од AI.')
      : L('The website was not audited in this run, so this is based on the AI answers only.', 'Сајтот не беше проверен во ова мерење, па ова се заснова само на одговорите од AI.');
  const avgPos = score.averagePosition;

  const enginesAnswered = [...new Set(answered.map((a) => a.engine))];
  const enginesMentioning = new Set(answered.filter((a) => a.mentioned).map((a) => a.engine));
  const silent = enginesAnswered.filter((e) => !enginesMentioning.has(e));
  const partial = enginesMentioning.size > 0 && silent.length > 0;
  const geminiAnswers = answered.filter((a) => a.engine === 'gemini');
  const geminiNamed = geminiAnswers.filter((a) => a.mentioned).length;
  const wrongClaims = (factCheck?.claims ?? []).filter((c) => c.status === 'possibly-wrong');
  const wrongEngines = [...new Set(wrongClaims.map((c) => c.engine))];

  const out: Recommendation[] = [];
  const add = (
    id: RecommendationId,
    priority: Priority,
    why: Localized[],
    steps: Localized[],
    status: 'todo' | 'done' = 'todo',
    snippet?: Recommendation['snippet'],
  ) => out.push({ id, priority, status, title: TITLES[id], why, steps, ...(snippet && status === 'todo' ? { snippet } : {}) });

  const priceList = (facts?.prices ?? []).map((p) => L(`${p.label} ${formatPriceFact(p).en}`, `${p.label} ${formatPriceFact(p).mk}`));
  const joinL = (items: Localized[], sep = '; ') => L(items.map((i) => i.en).join(sep), items.map((i) => i.mk).join(sep));

  // ---- Wrong facts ----
  if (factCheck && wrongClaims.length > 0 && facts) {
    const seen = new Set<string>();
    const why: Localized[] = [];
    for (const c of wrongClaims) {
      const k = `${c.engine}|${c.value}`;
      if (seen.has(k) || why.length >= 4) continue;
      seen.add(k);
      why.push(describeWrongClaim(c, facts, ENGINE_LABELS[c.engine]));
    }
    const pricing = audit?.services.pricingPage;
    const steps: Localized[] = [];
    if (wrongClaims.some((c) => c.kind === 'price')) {
      steps.push(
        pricing
          ? L(
              `Check the prices page (${pricing}): every service should show its current starting price as plain text, not only inside images.`,
              `Проверете ја страницата со цени (${pricing}): секоја услуга треба да има тековна почетна цена напишана како текст, не само на слика.`,
            )
          : L(
              'Publish a prices page (for example /ceni) with each service and its starting price as plain text.',
              'Објавете страница со цени (на пр. /ceni), со секоја услуга и нејзината почетна цена напишана како текст.',
            ),
      );
    }
    if (wrongEngines.includes('gemini')) {
      steps.push(
        L(
          'Gemini: put the same services and prices in your Google Business Profile (Services and Products). Gemini relies on Google data.',
          'Gemini: внесете ги истите услуги и цени во Google Business Profile (Услуги и Производи). Gemini се потпира на податоците на Google.',
        ),
      );
    }
    if (wrongEngines.includes('openai')) {
      steps.push(
        L(
          "ChatGPT: when it searches the web it uses search indexes such as Bing's. Keep your site and Bing Places current and request a re-crawl in Bing Webmaster Tools.",
          'ChatGPT: кога пребарува на интернет, користи индекси како оној на Bing. Ажурирајте ги сајтот и Bing Places и побарајте повторно индексирање во Bing Webmaster Tools.',
        ),
      );
    }
    if (wrongEngines.includes('perplexity')) {
      steps.push(
        L(
          'Perplexity: open the sources it cited (listed in this report) and ask those sites to correct your details.',
          'Perplexity: отворете ги изворите што ги наведе (се во овој извештај) и побарајте од тие сајтови да ги исправат вашите податоци.',
        ),
      );
    }
    if (wrongEngines.includes('anthropic')) {
      steps.push(
        L(
          'Claude answers mostly from what it learned in training, so corrections appear only after models are updated. Fix the public sources first.',
          'Claude одговара главно од она што го научил при тренирањето, па исправките се гледаат дури кога ќе се ажурира моделот. Прво исправете ги јавните извори.',
        ),
      );
    }
    steps.push(
      L(
        'Put the same numbers in your schema (makesOffer), llms.txt and directory listings, so every source agrees.',
        'Ставете ги истите бројки во schema (makesOffer), llms.txt и во именците, за сите извори да кажуваат исто.',
      ),
      L('Run this check again in 2 to 4 weeks. Answers change slowly.', 'Повторете ја проверката за 2 до 4 недели. Одговорите се менуваат бавно.'),
    );
    add('fix-wrong-facts', 'high', why, steps);
  } else if (factCheck && factCheck.accuracy.correct > 0) {
    add(
      'fix-wrong-facts',
      'low',
      [
        L(
          `AI answers stated ${factCheck.accuracy.correct} of your facts correctly, and none looked wrong.`,
          `Одговорите од AI точно наведоа ${factCheck.accuracy.correct} ваши податоци и ниту еден не изгледаше погрешен.`,
        ),
      ],
      [L('Keep prices and contact details identical on every profile when they change.', 'Кога ќе се сменат цените или контактот, ажурирајте ги истовремено на сите профили.')],
      'done',
    );
  }

  // ---- Google Business Profile ----
  {
    const why: Localized[] = [named];
    if (geminiAnswers.length > 0) {
      why.push(
        L(
          `Gemini named you in ${geminiNamed} of ${geminiAnswers.length} answers. Gemini leans on Google's own data: Search, Maps and Business Profiles.`,
          `Gemini ве спомна во ${geminiNamed} од ${geminiAnswers.length} одговори. Gemini се потпира на податоците на Google: пребарување, мапи и Business Profile.`,
        ),
      );
    }
    const geminiWrong = wrongClaims.filter((c) => c.engine === 'gemini');
    if (facts) for (const c of geminiWrong.slice(0, 2)) why.push(describeWrongClaim(c, facts, 'Gemini'));
    const priority: Priority =
      m < 0.5 || geminiWrong.length > 0 || (geminiAnswers.length > 0 && geminiNamed === 0) ? 'high' : avgPos === null || avgPos > 3 ? 'medium' : 'low';
    add('google-business-profile', priority, why, [
      L('Claim the profile at business.google.com and verify the address.', 'Преземете го профилот на business.google.com и потврдете ја адресата.'),
      L(`Use exactly the name "${official}", the same as on your site.`, `Користете го точно името „${official}“, исто како на сајтот.`),
      priceList.length > 0
        ? L(
            `Add every service with its starting price: ${joinL(priceList).en}.`,
            `Додајте ја секоја услуга со почетна цена: ${joinL(priceList).mk}.`,
          )
        : L('Add every service and, where you can, its starting price.', 'Додајте ја секоја услуга и, каде што може, почетната цена.'),
      L(
        'Pick the primary category customers would use, and add opening hours, photos and a description that names your city.',
        'Изберете главна категорија како што би ја кажале клиентите, и додајте работно време, фотографии и опис во кој се спомнува градот.',
      ),
      L('Post an update at least once a month so the profile looks active.', 'Објавувајте новост барем еднаш месечно за профилот да изгледа активен.'),
    ]);
  }

  // ---- Schema ----
  {
    const steps = [
      L(
        'Add a JSON-LD block of type LocalBusiness (or a subtype such as ProfessionalService) to the home and contact pages. A draft built from your facts is below.',
        'Додајте JSON-LD блок од тип LocalBusiness (или подтип, на пр. ProfessionalService) на почетната и на страницата за контакт. Подолу има нацрт направен од вашите податоци.',
      ),
      L(
        'Include name, url, telephone, address, areaServed, your services with prices (makesOffer) and sameAs links to Facebook, Instagram, LinkedIn and Google.',
        'Вклучете име, url, телефон, адреса, areaServed, услугите со цени (makesOffer) и sameAs линкови до Facebook, Instagram, LinkedIn и Google.',
      ),
      L('Check it with the Schema.org validator and Google Rich Results Test.', 'Проверете го со Schema.org validator и Google Rich Results Test.'),
    ];
    const snippet = { label: L('JSON-LD draft (check before publishing)', 'Нацрт JSON-LD (проверете пред да го објавите)'), code: schemaDraft(business, facts, audit) };
    if (!audit) {
      add('schema-localbusiness', m < 0.25 ? 'high' : m < 0.6 ? 'medium' : 'low', [notAudited, named], steps, 'todo', snippet);
    } else if (!audit.schema.present) {
      const why = [L(`No LocalBusiness or Organization schema (JSON-LD) found on ${site}.`, `На ${site} нема LocalBusiness ни Organization schema (JSON-LD).`)];
      if (audit.schema.invalidBlocks > 0)
        why.push(L(`${audit.schema.invalidBlocks} JSON-LD block(s) on the page could not be parsed.`, `${audit.schema.invalidBlocks} JSON-LD блок(ови) на страницата не можат да се прочитаат.`));
      add('schema-localbusiness', m < 0.6 ? 'high' : 'medium', why, steps, 'todo', snippet);
    } else {
      const missing = missingSchemaFields(audit);
      const phoneMismatch =
        facts && facts.phones.length > 0 && audit.schema.telephone && !facts.phones.some((p) => samePhone(p, audit.schema.telephone!));
      if (missing.length === 0 && !phoneMismatch) {
        add(
          'schema-localbusiness',
          'low',
          [L(`Schema on ${site} has name, telephone, address, prices and sameAs links.`, `Schema на ${site} има име, телефон, адреса, цени и sameAs линкови.`)],
          [L('Keep it in sync when prices or contact details change.', 'Ажурирајте ја кога ќе се сменат цените или контактот.')],
          'done',
        );
      } else {
        const why: Localized[] = [];
        if (missing.length > 0) {
          const labels = missing.map((f) => SCHEMA_FIELD_LABELS[f]);
          why.push(
            L(
              `Schema found on ${site} (${audit.schema.types.slice(0, 3).join(', ')}), but it is missing: ${labels.map((l) => l.en).join(', ')}.`,
              `На ${site} има schema (${audit.schema.types.slice(0, 3).join(', ')}), но недостасува: ${labels.map((l) => l.mk).join(', ')}.`,
            ),
          );
        }
        if (phoneMismatch)
          why.push(
            L(
              `The schema telephone is ${audit.schema.telephone}, but your number is ${facts!.phones.join(', ')}.`,
              `Телефонот во schema е ${audit.schema.telephone}, а вашиот број е ${facts!.phones.join(', ')}.`,
            ),
          );
        add('schema-localbusiness', missing.includes('telephone') || missing.includes('address') || phoneMismatch ? 'high' : 'medium', why, steps, 'todo', snippet);
      }
    }
  }

  // ---- Name, address, phone consistency ----
  {
    const variants = (factCheck?.nameVariants ?? []).filter((v) => v.kind === 'other');
    const siteNames = audit ? inconsistentSiteNames(audit, business, facts) : [];
    const siteShows = audit?.brandNames.find((b) => b.source === 'og:site_name' || b.source === 'schema')?.value ?? official;
    const why: Localized[] = [];
    for (const v of variants.slice(0, 3)) {
      why.push(
        L(
          `${engines(v.engines)} called you "${v.name}" (${v.count} ${v.count === 1 ? 'answer' : 'answers'}); your site says "${siteShows}".`,
          `${engines(v.engines)} ве нарече „${v.name}“ (${v.count} ${v.count === 1 ? 'одговор' : 'одговори'}); на сајтот пишува „${siteShows}“.`,
        ),
      );
    }
    if (siteNames.length > 0) {
      why.push(
        L(
          `Your site itself uses other names: ${siteNames.map((n) => quote(n).en).join(', ')}.`,
          `И самиот сајт користи други имиња: ${siteNames.map((n) => quote(n).mk).join(', ')}.`,
        ),
      );
    }
    const knownPhones = facts?.phones ?? [];
    const phoneOff =
      audit && knownPhones.length > 0 && audit.phonesOnSite.length > 0 && !audit.phonesOnSite.some((p) => knownPhones.some((k) => samePhone(k, p)));
    if (phoneOff)
      why.push(L(`The home page shows ${audit!.phonesOnSite.join(', ')}, not ${knownPhones.join(', ')}.`, `Почетната страница прикажува ${audit!.phonesOnSite.join(', ')}, а не ${knownPhones.join(', ')}.`));
    if (partial && why.length === 0)
      why.push(
        L(
          `Named by ${engines([...enginesMentioning])} but not by ${engines(silent)}. Inconsistent details make it harder to recognise one business across sources.`,
          `Ве спомнува ${engines([...enginesMentioning])}, но не и ${engines(silent)}. Различните податоци го отежнуваат препознавањето дека станува збор за ист бизнис.`,
        ),
      );
    const steps: Localized[] = [
      L(`Choose one spelling, "${official}", and use it on the site, Google, social profiles and directories.`, `Изберете едно пишување, „${official}“, и користете го на сајтот, на Google, на социјалните мрежи и во именците.`),
    ];
    for (const v of variants.slice(0, 2)) {
      steps.push(
        L(
          `Search the web for "${v.name}" and fix listings that use it. If you really go by that name too, add it to your schema as alternateName.`,
          `Пребарајте „${v.name}“ на интернет и поправете ги профилите што го користат. Ако навистина се претставувате и така, додајте го во schema како alternateName.`,
        ),
      );
    }
    steps.push(
      L('Use the same address and phone in the site footer, Google Business Profile, social profiles and directories.', 'Користете иста адреса и телефон во футерот на сајтот, Google Business Profile, социјалните мрежи и именците.'),
      L('Fix or remove old listings with outdated details.', 'Поправете ги или избришете ги старите профили со застарени податоци.'),
    );
    if (why.length > 0) {
      const priority: Priority = variants.some((v) => v.count >= 2) || siteNames.length > 0 || phoneOff || partial ? 'high' : 'medium';
      add('consistent-nap', priority, why, steps);
    } else if (audit && factCheck && factCheck.nameVariants.length > 0) {
      add(
        'consistent-nap',
        'low',
        [L(`Every answer that named you used "${official}" or an allowed spelling, and your site uses one name.`, `Секој одговор што ве спомна го користеше „${official}“ или дозволено пишување, а сајтот користи едно име.`)],
        [L('Audit your listings once a quarter.', 'Проверувајте ги профилите еднаш на три месеци.')],
        'done',
      );
    } else {
      add('consistent-nap', m < 0.5 ? 'medium' : 'low', [named, ...(audit ? [] : [notAudited])], steps);
    }
  }

  // ---- AI crawlers ----
  if (audit && audit.robots.state !== 'unknown') {
    const blocked = audit.robots.blockedAiBots;
    if (blocked.length > 0) {
      add(
        'ai-crawlers',
        'high',
        [L(`robots.txt on ${site} blocks: ${blocked.join(', ')}.`, `robots.txt на ${site} ги блокира: ${blocked.join(', ')}.`)],
        [
          L('Remove the "Disallow: /" rules for these bots in robots.txt, unless you blocked them on purpose.', 'Отстранете ги правилата „Disallow: /“ за овие роботи во robots.txt, освен ако намерно сте ги блокирале.'),
          L(
            'Check your host or CDN (for example a "block AI bots" switch in Cloudflare); it can block them even when robots.txt allows them.',
            'Проверете го хостингот или CDN-от (на пр. опцијата „block AI bots“ во Cloudflare); може да ги блокира и кога robots.txt ги дозволува.',
          ),
          L('Google-Extended controls whether Gemini may use your pages; it does not affect your Google Search ranking.', 'Google-Extended одредува дали Gemini смее да ги користи вашите страници; не влијае на позицијата во Google пребарување.'),
        ],
      );
    } else {
      add('ai-crawlers', 'low', [L(`robots.txt on ${site} does not block AI crawlers.`, `robots.txt на ${site} не ги блокира AI роботите.`)], [], 'done');
    }
  }

  // ---- Reviews ----
  {
    const you = shareOfVoice.find((r) => r.isYou);
    const leader = shareOfVoice.find(
      (r) =>
        !r.isYou &&
        you !== undefined &&
        (r.mentions > you.mentions || (r.mentions === you.mentions && r.mentions > 0 && (r.averagePosition ?? 99) < (you.averagePosition ?? 99))),
    );
    const steps = [
      L('Ask every finished client for a Google review; send them a direct review link.', 'Побарајте Google рецензија од секој задоволен клиент; испратете директен линк.'),
      L('Ask reviewers to mention the service and the city in their own words.', 'Замолете ги да ја спомнат услугата и градот со свои зборови.'),
      L('Reply to every review, including negative ones.', 'Одговорете на секоја рецензија, и на негативните.'),
      L('Show strong testimonials on your site with the client name and project.', 'Покажете ги добрите препораки на сајтот, со име на клиентот и проектот.'),
    ];
    if (leader) {
      add(
        'reviews',
        'high',
        [
          L(
            `${leader.name} was named ${leader.mentions} times against your ${you?.mentions ?? 0}${leader.averagePosition !== null ? `, at average rank ${r1(leader.averagePosition)}` : ''}.`,
            `${leader.name} беше спомнат ${leader.mentions} пати, а вие ${you?.mentions ?? 0}${leader.averagePosition !== null ? `, со просечна позиција ${r1(leader.averagePosition)}` : ''}.`,
          ),
          L('The number and freshness of reviews is a common reason one local business is preferred.', 'Бројот и свежината на рецензиите често се причина еден локален бизнис да има предност.'),
        ],
        steps,
      );
    } else if (avgPos !== null && avgPos > 2) {
      add('reviews', 'medium', [L(`Your average rank when listed is ${r1(avgPos)}.`, `Вашата просечна позиција во листите е ${r1(avgPos)}.`)], steps);
    } else if (m < 0.5) {
      add('reviews', 'medium', [named, L('Reviews give assistants independent evidence that you exist and are good.', 'Рецензиите им даваат на асистентите независен доказ дека постоите и дека сте добри.')], steps);
    }
  }

  // ---- Service pages ----
  {
    const steps = [
      L('Create a page for each service with the service and the city in the title and the main heading.', 'Направете страница за секоја услуга, со услугата и градот во насловот и главниот наслов (H1).'),
      L('Start with two plain sentences: what you do, for whom, where and from what price.', 'Почнете со две јасни реченици: што правите, за кого, каде и од која цена.'),
      L('Add the process, timeline, FAQs and real project examples, and link the pages from the menu.', 'Додајте процес, рокови, чести прашања и вистински примери, и поврзете ги страниците од менито.'),
    ];
    if (audit) {
      const pages = audit.services.pages.filter((p) => p.url !== audit.services.pricingPage);
      const missingFor = (facts?.prices ?? []).filter((p) => p.label.trim() && !pageFor(p.label, audit)).map((p) => p.label);
      if (pages.length >= 2 && missingFor.length === 0) {
        add(
          'service-pages',
          'low',
          [
            L(
              `${pages.length} service pages are linked from ${site}: ${pages.slice(0, 4).map((p) => pathOf(p.url)).join(', ')}.`,
              `${pages.length} страници за услуги се поврзани од ${site}: ${pages.slice(0, 4).map((p) => pathOf(p.url)).join(', ')}.`,
            ),
          ],
          [],
          'done',
        );
      } else {
        const why: Localized[] = [];
        if (pages.length < 2) {
          why.push(
            audit.services.sectionAnchors > 0
              ? L(
                  `On ${site} the services are sections of one page (#links), not separate pages. Assistants quote pages, not sections.`,
                  `На ${site} услугите се делови од една страница (# линкови), не посебни страници. Асистентите цитираат страници, не делови.`,
                )
              : L(`Only ${pages.length} service page(s) found in the links on ${site}.`, `Во линковите на ${site} се пронајдени само ${pages.length} страници за услуги.`),
          );
        }
        if (missingFor.length > 0)
          why.push(L(`No page found for: ${missingFor.join(', ')}.`, `Нема страница за: ${missingFor.join(', ')}.`));
        add('service-pages', m < 0.25 || pages.length === 0 ? 'high' : 'medium', why, steps);
      }
    } else if (m < 0.6 || partial) {
      add(
        'service-pages',
        m < 0.25 ? 'high' : 'medium',
        [notAudited, partial ? L(`${engines(silent)} never named you, while other engines did.`, `${engines(silent)} не ве спомна ниту еднаш, а другите да.`) : named],
        steps,
      );
    }
  }

  // ---- Directories from cited sources ----
  {
    const own = normalizeDomain(business.domain);
    const citing = answered.filter((a) => a.citations.length > 0);
    const domainCited = answered.some((a) => a.domainCited);
    const absent = sourcesWithoutYou(analyses, own);
    const steps: Localized[] = [];
    if (absent.length > 0) {
      const names = absent.map((d) => d.domain).join(', ');
      steps.push(L(`Check whether you are listed on: ${names}. If not, create a profile; if yes, complete it.`, `Проверете дали сте на: ${names}. Ако не сте, направете профил; ако сте, пополнете го.`));
    }
    steps.push(
      L(`Use exactly the name "${official}" and the same address, phone and website on every listing.`, `На секој профил користете го точно името „${official}“ и иста адреса, телефон и веб-страница.`),
      L('Ask partners, clients and local media to link to you with your business name.', 'Замолете партнери, клиенти и локални медиуми да ве линкуваат со името на бизнисот.'),
    );
    if (absent.length > 0) {
      add(
        'directory-citations',
        domainCited ? 'medium' : 'high',
        [
          L(
            `Sources cited in answers that did not name you: ${absent.map((d) => `${d.domain} (${d.count})`).join(', ')}.`,
            `Извори цитирани во одговори во кои не сте спомнати: ${absent.map((d) => `${d.domain} (${d.count})`).join(', ')}.`,
          ),
          ...(domainCited ? [] : [L(`Your own site was never cited as a source (${citing.length} answers listed sources).`, `Вашиот сајт не беше цитиран ниту еднаш (${citing.length} одговори наведоа извори).`)]),
        ],
        steps,
      );
    } else if (citing.length === 0 && m < 0.5) {
      add('directory-citations', 'medium', [named, L('Third-party listings give assistants more places to learn about you.', 'Профилите на други сајтови им даваат на асистентите повеќе места каде да дознаат за вас.')], steps);
    }
  }

  // ---- Macedonian + English ----
  {
    const steps = [
      L('Offer the key service pages in both Macedonian (Cyrillic) and English.', 'Понудете ги главните страници за услуги на македонски (кирилица) и на англиски.'),
      L('Write the words customers actually use in each language, not word-for-word translations.', 'Користете ги зборовите што клиентите навистина ги користат на секој јазик, не буквален превод.'),
      L('Link the language versions with hreflang tags and keep URLs stable (for example /en/...).', 'Поврзете ги јазичните верзии со hreflang ознаки и чувајте стабилни адреси (на пр. /en/...).'),
    ];
    if (audit) {
      const { hasMk, hasEn } = audit.languages;
      if (hasMk && hasEn) {
        add('local-language-content', 'low', [L(`${site} has Macedonian and English content.`, `${site} има содржина на македонски и на англиски.`)], [], 'done');
      } else {
        const promptLangMissing = (business.language === 'mk' && !hasMk) || (business.language === 'en' && !hasEn);
        add(
          'local-language-content',
          promptLangMissing ? 'high' : 'medium',
          [
            hasMk
              ? L(`${site} looks Macedonian-only: no English version or hreflang found.`, `${site} изгледа само на македонски: нема англиска верзија ни hreflang.`)
              : hasEn
                ? L(`${site} looks English-only: no Macedonian version found.`, `${site} изгледа само на англиски: нема македонска верзија.`)
                : L(`The language of ${site} could not be determined.`, `Јазикот на ${site} не може да се одреди.`),
          ],
          steps,
        );
      }
    } else if (business.language === 'mk' && m < 0.5) {
      add('local-language-content', m < 0.25 ? 'high' : 'medium', [named, L('The prompts were in Macedonian, so Macedonian pages matter.', 'Прашањата беа на македонски, па страниците на македонски се важни.')], steps);
    }
  }

  // ---- llms.txt ----
  {
    const steps = [
      L('Create /llms.txt at the root of the site. A draft built from your details is below.', 'Направете /llms.txt во коренот на сајтот. Подолу има нацрт од вашите податоци.'),
      L('Keep it in sync with the site. It is an emerging convention: cheap insurance, not a fix on its own.', 'Ажурирајте ја заедно со сајтот. Ова е нова конвенција: евтина заштита, а не решение само по себе.'),
    ];
    const snippet = { label: L('llms.txt draft', 'Нацрт llms.txt'), code: llmsTxtDraft(business, facts, audit) };
    if (audit?.llmsTxt.state === 'present') {
      add('llms-txt', 'low', [L(`${site}/llms.txt exists (${audit.llmsTxt.bytes} bytes).`, `${site}/llms.txt постои (${audit.llmsTxt.bytes} бајти).`)], [], 'done');
    } else if (audit?.llmsTxt.state === 'missing') {
      add(
        'llms-txt',
        m < 0.5 ? 'medium' : 'low',
        [L(`${site}/llms.txt was not found (HTTP ${audit.llmsTxt.status ?? '–'}).`, `${site}/llms.txt не постои (HTTP ${audit.llmsTxt.status ?? '–'}).`)],
        steps,
        'todo',
        snippet,
      );
    } else {
      add(
        'llms-txt',
        m < 0.5 ? 'medium' : 'low',
        [audit ? L('llms.txt could not be checked (the request failed).', 'llms.txt не можеше да се провери (барањето не успеа).') : notAudited],
        steps,
        'todo',
        snippet,
      );
    }
  }

  // ---- Bing (Copilot) ----
  add(
    'bing',
    m < 0.5 ? 'medium' : 'low',
    [
      L(
        "Microsoft Copilot answers from Bing's index. This tool cannot test Copilot (there is no public API for it), so this item covers it indirectly.",
        'Microsoft Copilot одговара од индексот на Bing. Оваа алатка не може да го тестира Copilot (нема јавен API), па оваа точка го покрива индиректно.',
      ),
    ],
    [
      L('Verify the site in Bing Webmaster Tools (you can import it from Google Search Console).', 'Потврдете го сајтот во Bing Webmaster Tools (може да го увезете од Google Search Console).'),
      audit?.sitemap === 'present'
        ? L('Submit your sitemap there.', 'Таму поднесете ја мапата на сајтот (sitemap).')
        : L('Create a sitemap.xml and submit it there.', 'Направете sitemap.xml и поднесете ја таму.'),
      L('Claim Bing Places for Business (it can import your Google Business Profile).', 'Преземете го профилот на Bing Places for Business (може да го увезе Google Business Profile).'),
      L('Turn on IndexNow (many hosts and CMS plugins support it) so Bing sees changes within days.', 'Вклучете IndexNow (го поддржуваат многу хостинзи и додатоци) за Bing да ги види промените за неколку дена.'),
    ],
  );

  // ---- Page speed and mobile ----
  if (audit) {
    const problems: Localized[] = [];
    if (!audit.viewport) problems.push(L('No mobile viewport tag: the site may render zoomed out on phones.', 'Нема ознака за мобилен приказ: на телефон сајтот може да се прикаже смалено.'));
    if (!audit.https) problems.push(L('The site is served over plain http.', 'Сајтот се отвора преку небезбедно http.'));
    else if (audit.httpRedirectsToHttps === false) problems.push(L('http:// does not redirect to https://.', 'http:// не пренасочува кон https://.'));
    const psi = audit.psi;
    if (psi?.performance !== null && psi?.performance !== undefined && psi.performance < 50)
      problems.push(L(`PageSpeed mobile performance is ${psi.performance}/100.`, `PageSpeed оценка за брзина на мобилен е ${psi.performance}/100.`));
    if (psi?.lcpMs && psi.lcpMs > 4000)
      problems.push(L(`Main content appears after ${(psi.lcpMs / 1000).toFixed(1)} s (LCP; aim for under 2.5 s).`, `Главната содржина се појавува по ${(psi.lcpMs / 1000).toFixed(1)} s (LCP; целта е под 2,5 s).`));
    if (problems.length > 0) {
      add(
        'page-speed',
        !audit.viewport || (psi?.performance ?? 100) < 50 ? 'high' : 'medium',
        problems,
        [
          L('Compress and resize images (WebP/AVIF) and lazy-load anything below the fold.', 'Компресирајте ги и намалете ги сликите (WebP/AVIF) и вчитувајте ги подоцна оние што не се видливи веднаш.'),
          L('Remove unused scripts, plugins and heavy sliders.', 'Отстранете ги непотребните скрипти, додатоци и тешки слајдери.'),
          L('Add a viewport tag and redirect all http traffic to https.', 'Додајте viewport ознака и пренасочете го целиот http сообраќај кон https.'),
        ],
      );
    } else if (psi && psi.performance !== null) {
      add('page-speed', 'low', [L(`PageSpeed mobile performance is ${psi.performance}/100, and the site is mobile-ready.`, `PageSpeed оценка на мобилен е ${psi.performance}/100, а сајтот е прилагоден за мобилен.`)], [], 'done');
    }
  }

  return out.sort(
    (a, b) =>
      Number(a.status === 'done') - Number(b.status === 'done') ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );
}
