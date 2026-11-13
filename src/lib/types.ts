/** Shared domain types used by the UI, the analyzers and the Netlify Function. */

export type Language = 'en' | 'mk';

export type EngineId = 'anthropic' | 'openai' | 'perplexity';

export const ENGINE_IDS: readonly EngineId[] = ['anthropic', 'openai', 'perplexity'];

export const ENGINE_LABELS: Record<EngineId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
};

export interface BusinessInput {
  /** Business name as the owner writes it, e.g. "Example Studio". */
  name: string;
  /** Other names the business is known by, e.g. a Cyrillic spelling. */
  aliases: string[];
  /** Website domain, e.g. "examplestudio.mk". Protocol and path are ignored. */
  domain: string;
  /** What people search for, e.g. "web design agency". */
  category: string;
  city: string;
  country: string;
  competitors: string[];
  language: Language;
}

export interface EngineStatus {
  id: EngineId;
  label: string;
  available: boolean;
  model: string | null;
}

/** What a single engine returned for a single prompt. */
export interface EngineAnswer {
  engine: EngineId;
  model: string;
  prompt: string;
  ok: boolean;
  text: string;
  /** URLs the engine cited as sources (Perplexity citations, OpenAI url_citation annotations). */
  citations: string[];
  error?: string;
  latencyMs: number;
}

export type MatchType = 'exact' | 'normalized' | 'fuzzy' | 'domain';

export interface MentionResult {
  mentioned: boolean;
  matchType: MatchType | null;
  /** The text that matched, as it appears in the answer. */
  matchedText: string | null;
}

export interface ListItem {
  position: number;
  text: string;
}

export interface CompetitorHit {
  name: string;
  position: number | null;
}

export interface AnswerAnalysis {
  engine: EngineId;
  prompt: string;
  ok: boolean;
  mentioned: boolean;
  matchType: MatchType | null;
  matchedText: string | null;
  /** 1-based rank of the business if the answer is a list and it appears in it. */
  position: number | null;
  listLength: number;
  competitors: CompetitorHit[];
  citations: string[];
  /** True if one of the cited URLs is on the business's own domain. */
  domainCited: boolean;
}

export interface ScoreBreakdown {
  score: number;
  band: 'invisible' | 'emerging' | 'visible' | 'leading';
  mentionRate: number;
  positionScore: number;
  engineCoverage: number;
  answered: number;
  mentionedCount: number;
  enginesAnswered: number;
  enginesMentioning: number;
  averagePosition: number | null;
}

export interface ShareOfVoiceRow {
  name: string;
  isYou: boolean;
  mentions: number;
  share: number;
  averagePosition: number | null;
  engines: EngineId[];
}

export type Priority = 'high' | 'medium' | 'low';

export type RecommendationId =
  | 'schema-localbusiness'
  | 'google-business-profile'
  | 'reviews'
  | 'service-pages'
  | 'llms-txt'
  | 'directory-citations'
  | 'consistent-nap'
  | 'local-language-content';

export interface Recommendation {
  id: RecommendationId;
  priority: Priority;
  title: string;
  /** Why this was recommended, built from the run's numbers. */
  reason: string;
  steps: string[];
}

// ---------- Website audit (GEO readiness) ----------

/** Result of a side check that can fail for reasons unrelated to the site (timeouts, blocks). */
export type CheckState = 'present' | 'missing' | 'unknown';

export interface BrandNameSource {
  source: 'title' | 'og:site_name' | 'application-name' | 'schema' | 'schema:alternateName';
  value: string;
}

export interface SchemaSummary {
  /** A schema.org Organization / LocalBusiness (or subtype) node was found in JSON-LD. */
  present: boolean;
  types: string[];
  invalidBlocks: number;
  name: string | null;
  alternateNames: string[];
  telephone: string | null;
  address: string | null;
  priceRange: string | null;
  /** makesOffer, offers or hasOfferCatalog present on the business node. */
  hasOffers: boolean;
  sameAs: string[];
}

export interface LanguageSignals {
  htmlLang: string;
  hreflang: string[];
  /** Share of letters in the visible text that are Cyrillic, 0-1. */
  cyrillicShare: number;
  hasMk: boolean;
  hasEn: boolean;
  /** Links that look like a language switcher (text "EN", "МК", or /en/ paths). */
  switcherLinks: string[];
}

export interface ServiceLink {
  url: string;
  text: string;
}

export interface PsiSummary {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
}

export interface SiteAudit {
  version: 1;
  domain: string;
  finalUrl: string;
  checkedAt: string;
  https: boolean;
  /** null when it could not be checked (http port closed, or the site is http-only). */
  httpRedirectsToHttps: boolean | null;
  /** A viewport meta with width=device-width. */
  viewport: boolean;
  title: string | null;
  metaDescription: string | null;
  telLinks: number;
  brandNames: BrandNameSource[];
  schema: SchemaSummary;
  llmsTxt: { state: CheckState; status: number | null; bytes: number };
  robots: { state: CheckState; blockedAiBots: string[] };
  sitemap: CheckState;
  languages: LanguageSignals;
  services: {
    /** Same-site links that look like service or pricing pages. */
    pages: ServiceLink[];
    /** In-page anchors (#services) that look like services: sections, not separate pages. */
    sectionAnchors: number;
    pricingPage: string | null;
  };
  /** Phone numbers from tel: links and schema telephone, as written. */
  phonesOnSite: string[];
  psi: PsiSummary | null;
  psiStatus: 'ok' | 'not-configured' | 'failed' | 'skipped';
}

export interface VisibilityReport {
  version: 1;
  generatedAt: string;
  /** True when the report was built from bundled example data, not live engine calls. */
  demo: boolean;
  business: BusinessInput;
  prompts: string[];
  engines: EngineStatus[];
  answers: EngineAnswer[];
  analyses: AnswerAnalysis[];
  score: ScoreBreakdown;
  shareOfVoice: ShareOfVoiceRow[];
  topCitedDomains: { domain: string; count: number }[];
  recommendations: Recommendation[];
}
