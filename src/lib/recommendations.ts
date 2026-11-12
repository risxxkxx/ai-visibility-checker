import type {
  AnswerAnalysis,
  BusinessInput,
  Priority,
  Recommendation,
  RecommendationId,
  ScoreBreakdown,
  ShareOfVoiceRow,
} from './types.ts';
import { ENGINE_LABELS } from './types.ts';
import { hostMatchesDomain, normalizeDomain } from './normalize.ts';

/**
 * Rule-based recommendations. The catalogue below is fixed: a run never invents advice.
 * Each rule decides from the run's numbers whether an item applies, at what priority,
 * and fills in a reason that quotes those numbers.
 */
export const CATALOGUE: Record<RecommendationId, { title: string; steps: string[] }> = {
  'google-business-profile': {
    title: 'Claim and complete your Google Business Profile',
    steps: [
      'Claim the profile at business.google.com and verify the address.',
      'Pick the primary category that matches how customers describe you.',
      'Add services, opening hours, photos and a description that names your city.',
      'Post an update at least monthly so the profile looks active.',
    ],
  },
  'schema-localbusiness': {
    title: 'Add LocalBusiness structured data (schema.org)',
    steps: [
      'Add a JSON-LD block of type LocalBusiness (or a more specific subtype) to your home and contact pages.',
      'Include name, url, logo, address, telephone, geo, openingHours, areaServed and sameAs links to your profiles.',
      'List your services with makesOffer or a Service type on each service page.',
      'Validate with the Schema.org validator and Google Rich Results Test.',
    ],
  },
  reviews: {
    title: 'Collect more recent, detailed reviews',
    steps: [
      'Ask every finished client for a Google review; send a direct review link.',
      'Ask reviewers to mention the service and the city in their own words.',
      'Reply to every review, including negative ones.',
      'Mirror strong testimonials on your site with the client name and project.',
    ],
  },
  'service-pages': {
    title: 'Publish one clear page per service',
    steps: [
      'Create a page for each service with the service and city in the title and H1.',
      'Open with a two-sentence plain answer: what you do, for whom, where.',
      'Add prices or price ranges, process, timeline, FAQs and real project examples.',
      'Link the pages from your navigation and from each other.',
    ],
  },
  'llms-txt': {
    title: 'Add an llms.txt file',
    steps: [
      'Create /llms.txt with a short summary of the business, services, location and contact.',
      'Link to your key service, about and contact pages in markdown.',
      'Keep it in sync with the site. It is an emerging convention, so treat it as cheap insurance, not a fix.',
    ],
  },
  'directory-citations': {
    title: 'Get listed where AI assistants look',
    steps: [
      'Create or update profiles on the directories and review sites relevant to your category and country.',
      'Use the exact same business name, address, phone and website on every listing.',
      'Ask partners, clients and local media to link to you with your business name.',
    ],
  },
  'consistent-nap': {
    title: 'Make your name, address and phone consistent everywhere',
    steps: [
      'Choose one spelling of the business name (and one official alternative script, if any).',
      'Use the same name, address and phone on your site footer, Google, social profiles and directories.',
      'Fix or remove old listings with outdated details.',
      'Add the alternative-script name to your site and schema as alternateName.',
    ],
  },
  'local-language-content': {
    title: 'Publish content in Macedonian as well as English',
    steps: [
      'Offer the key service pages in Macedonian, with Cyrillic headings.',
      'Use the words customers use in Macedonian searches, not only translated marketing copy.',
      'Mark the language versions with hreflang and keep URLs stable.',
    ],
  },
};

const ORDER: RecommendationId[] = [
  'google-business-profile',
  'schema-localbusiness',
  'reviews',
  'service-pages',
  'directory-citations',
  'consistent-nap',
  'local-language-content',
  'llms-txt',
];

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export interface RecommendationInput {
  business: BusinessInput;
  analyses: AnswerAnalysis[];
  score: ScoreBreakdown;
  shareOfVoice: ShareOfVoiceRow[];
  topCitedDomains: { domain: string; count: number }[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const { business, analyses, score, shareOfVoice } = input;
  const answered = analyses.filter((a) => a.ok);
  if (answered.length === 0) return [];

  const m = score.mentionRate;
  const named = `Named in ${score.mentionedCount} of ${score.answered} answers (${pct(m)}).`;
  const avgPos = score.averagePosition;
  const you = shareOfVoice.find((r) => r.isYou);
  const leader = shareOfVoice.find(
    (r) =>
      !r.isYou &&
      you !== undefined &&
      (r.mentions > you.mentions ||
        (r.mentions === you.mentions && r.mentions > 0 && (r.averagePosition ?? 99) < (you.averagePosition ?? 99))),
  );

  const enginesAnswered = [...new Set(answered.map((a) => a.engine))];
  const enginesMentioning = new Set(answered.filter((a) => a.mentioned).map((a) => a.engine));
  const silentEngines = enginesAnswered.filter((e) => !enginesMentioning.has(e));
  const partialCoverage = enginesMentioning.size > 0 && silentEngines.length > 0;

  const citingAnswers = answered.filter((a) => a.citations.length > 0);
  const domainCited = answered.some((a) => a.domainCited);
  const ownDomain = normalizeDomain(business.domain);
  const sourceDomains = input.topCitedDomains
    .filter((d) => !ownDomain || !hostMatchesDomain(d.domain, ownDomain))
    .slice(0, 5)
    .map((d) => d.domain);

  const out: Recommendation[] = [];
  const add = (id: RecommendationId, priority: Priority, reason: string, extraSteps: string[] = []) => {
    out.push({ id, priority, title: CATALOGUE[id].title, reason, steps: [...extraSteps, ...CATALOGUE[id].steps] });
  };

  // Google Business Profile: the main local signal; always worth checking.
  if (m < 0.5) add('google-business-profile', 'high', `${named} Assistants lean on map and profile data for local questions.`);
  else if (avgPos === null || avgPos > 3)
    add('google-business-profile', 'medium', `${named} You are named but rarely near the top${avgPos ? ` (average rank ${avgPos})` : ''}.`);
  else add('google-business-profile', 'low', `${named} Keep the profile current to hold your position.`);

  // Structured data.
  if (m < 0.25) add('schema-localbusiness', 'high', `${named} Machine-readable facts make it easier for models to connect your name, city and services.`);
  else if (m < 0.6 || (citingAnswers.length > 0 && !domainCited))
    add(
      'schema-localbusiness',
      'medium',
      citingAnswers.length > 0 && !domainCited
        ? `${named} Your site was not cited as a source in any of ${citingAnswers.length} answers that listed sources.`
        : named,
    );
  else add('schema-localbusiness', 'low', `${named} Check the markup is present and valid.`);

  // Reviews: when competitors are ahead or the rank is weak.
  if (leader) {
    add(
      'reviews',
      'high',
      `${leader.name} was named ${leader.mentions} times against your ${you?.mentions ?? 0}${
        leader.averagePosition !== null ? `, at average rank ${leader.averagePosition}` : ''
      }. Review volume and recency are a common reason one local business is preferred.`,
    );
  } else if (avgPos !== null && avgPos > 2) {
    add('reviews', 'medium', `Your average rank when listed is ${avgPos}. More recent reviews help move up.`);
  } else if (m < 0.5) {
    add('reviews', 'medium', `${named} Reviews give assistants independent evidence that you exist and are good.`);
  }

  // Service pages.
  if (m < 0.25) add('service-pages', 'high', `${named} Assistants need clear pages that say what you do and where.`);
  else if (m < 0.6 || partialCoverage)
    add(
      'service-pages',
      'medium',
      partialCoverage
        ? `${named} ${silentEngines.map((e) => ENGINE_LABELS[e]).join(' and ')} never named you, while other engines did.`
        : named,
    );

  // Directories and citations.
  if (citingAnswers.length > 0 && !domainCited) {
    add(
      'directory-citations',
      'high',
      `Engines cited sources in ${citingAnswers.length} answers, but never your site.${
        sourceDomains.length > 0 ? ` Most-cited sources: ${sourceDomains.join(', ')}.` : ''
      }`,
      sourceDomains.length > 0 ? [`Check whether you are listed on: ${sourceDomains.join(', ')}.`] : [],
    );
  } else if (m < 0.5) {
    add('directory-citations', 'medium', `${named} Third-party listings give assistants more places to learn about you.`);
  }

  // Consistent name, address, phone.
  if (partialCoverage)
    add(
      'consistent-nap',
      'high',
      `Named by ${[...enginesMentioning].map((e) => ENGINE_LABELS[e]).join(' and ')} but not by ${silentEngines
        .map((e) => ENGINE_LABELS[e])
        .join(' and ')}. Inconsistent details make it harder to recognise one business across sources.`,
    );
  else if (m < 0.5) add('consistent-nap', 'medium', `${named} Consistent details help models merge mentions into one business.`);
  else add('consistent-nap', 'low', 'Named by every engine that answered. Audit listings once a quarter.');

  // Local language.
  if (business.language === 'mk' && m < 0.5)
    add('local-language-content', m < 0.25 ? 'high' : 'medium', `${named} The prompts were in Macedonian, so Macedonian-language pages matter.`);

  // llms.txt: cheap, always listed, never top priority on its own.
  add('llms-txt', m < 0.5 ? 'medium' : 'low', 'Low effort. Not every assistant reads it yet, so it complements the items above.');

  return out.sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );
}
