/** Shared domain types used by the UI, the analyzers and the Netlify Function. */

export type Language = 'en' | 'mk';

export type EngineId = 'anthropic' | 'openai' | 'perplexity' | 'gemini';

export const ENGINE_IDS: readonly EngineId[] = ['anthropic', 'openai', 'perplexity', 'gemini'];

export const ENGINE_LABELS: Record<EngineId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
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
  /**
   * URLs the engine cited as sources (Perplexity citations, OpenAI url_citation annotations,
   * Gemini grounding chunks; Gemini's redirect links are reduced to the source domain).
   */
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
  /** 'no-data' when no engine answered (all calls failed), so a 0 is never shown as a real result. */
  band: 'no-data' | 'invisible' | 'emerging' | 'visible' | 'leading';
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
  | 'fix-wrong-facts'
  | 'google-business-profile'
  | 'schema-localbusiness'
  | 'consistent-nap'
  | 'ai-crawlers'
  | 'reviews'
  | 'service-pages'
  | 'directory-citations'
  | 'local-language-content'
  | 'llms-txt'
  | 'bing'
  | 'page-speed';

export interface Recommendation {
  id: RecommendationId;
  priority: Priority;
  /** "done" when this run's evidence shows it is already in place (e.g. schema found on the site). */
  status: 'todo' | 'done';
  title: Localized;
  /** Evidence from this run: numbers, quotes from answers, what the site audit found. */
  why: Localized[];
  steps: Localized[];
  /** Optional copy-paste draft (JSON-LD, llms.txt) built from the known facts. */
  snippet?: { label: Localized; code: string };
}

// ---------- Known facts and fact checking ----------

/** Text in both report languages. */
export interface Localized {
  en: string;
  mk: string;
}

export type ReportLanguage = 'en' | 'mk';

export type Currency = 'EUR' | 'MKD' | 'USD';

export interface PriceFact {
  /** What the price is for, e.g. "One Page website" or "Social media management". */
  label: string;
  /** The reference ("from") price. */
  amount: number;
  currency: Currency;
  perMonth: boolean;
}

/** Facts the owner knows are true, used to check what AI answers say. All optional. */
export interface KnownFacts {
  officialName: string;
  /** Other names that are fine to use, e.g. the Cyrillic spelling. */
  nameVariants: string[];
  phones: string[];
  prices: PriceFact[];
  city: string;
  address: string;
}

export type ClaimKind = 'phone' | 'price' | 'city' | 'address';

/** A claim is never called wrong with certainty: "possibly-wrong" means "verify this". */
export type ClaimStatus = 'correct' | 'possibly-wrong' | 'unverified';

export interface SnippetHighlight {
  start: number;
  end: number;
  kind: 'claim' | 'brand';
}

export interface Snippet {
  text: string;
  highlights: SnippetHighlight[];
}

export interface StatedPrice {
  min: number;
  max: number | null;
  currency: Currency;
  perMonth: boolean;
  from: boolean;
}

export interface FactClaim {
  kind: ClaimKind;
  engine: EngineId;
  prompt: string;
  /** The value as the answer wrote it, e.g. "€300–400 per month". */
  value: string;
  status: ClaimStatus;
  /** Key of the known fact it was compared with ("phone:0", "price:1", "city", "address"). */
  factKey: string | null;
  price?: StatedPrice;
  snippet: Snippet;
}

export type FactStatus = 'correct' | 'possibly-wrong' | 'not-mentioned';

export interface FactRow {
  key: string;
  kind: ClaimKind;
  label: Localized;
  expected: Localized;
  status: FactStatus;
  correct: number;
  wrong: number;
  engines: EngineId[];
}

export interface NameVariant {
  name: string;
  count: number;
  engines: EngineId[];
  kind: 'official' | 'allowed' | 'other';
}

export interface FactCheck {
  /** Answers that named the business, i.e. the ones that were read for facts. */
  answersChecked: number;
  claims: FactClaim[];
  rows: FactRow[];
  nameVariants: NameVariant[];
  /** Accuracy sub-score: correct ÷ (correct + possibly wrong) claims, null when nothing could be checked. */
  accuracy: { correct: number; wrong: number; score: number | null };
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

export type ReadinessId =
  | 'schema'
  | 'schema-fields'
  | 'llms-txt'
  | 'ai-crawlers'
  | 'languages'
  | 'service-pages'
  | 'prices-published'
  | 'name-consistency'
  | 'phone-on-site'
  | 'https'
  | 'mobile';

export interface ReadinessCheck {
  id: ReadinessId;
  state: 'pass' | 'fail' | 'unknown';
  weight: number;
  label: Localized;
  detail: Localized;
}

export interface Readiness {
  /** 0-100, or null when the site was not audited. See src/lib/readiness.ts. */
  score: number | null;
  checks: ReadinessCheck[];
}

export type AuditStatus = 'off' | 'no-domain' | 'running' | 'done' | 'failed';

export interface VisibilityReport {
  version: 2;
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
  /** Known facts entered by the owner, or null when the section was left empty. */
  knownFacts: KnownFacts | null;
  factCheck: FactCheck;
  audit: SiteAudit | null;
  auditStatus: AuditStatus;
  auditError: string | null;
  readiness: Readiness;
  recommendations: Recommendation[];
}
