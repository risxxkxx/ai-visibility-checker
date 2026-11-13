/**
 * What the public mini test (POST /api/public/check and /api/public/lead) shows a visitor.
 * Pure: built from a VisibilityReport, in one language. The summary is deliberately small;
 * the full report (all recommendations, per-prompt results, readiness checks, drafts) is only
 * returned after the visitor leaves an e-mail address.
 */
import type { BusinessInput, EngineAnswer, Priority, ReadinessCheck, ReportLanguage, ScoreBreakdown, VisibilityReport } from './types.ts';
import { extractLists, itemHead } from './lists.ts';
import { mentions } from './mention.ts';
import { brandTokens, normalizeDomain } from './normalize.ts';
import { BAND_TEXT, CHECK_STATE_TEXT, PRIORITY_TEXT } from './i18n.ts';
import { llmsTxtDraft, schemaDraft } from './recommendations.ts';
import { LIMITS } from './validation.ts';

/** Prompts per public check. Gemini only, so one check is 5 engine requests. */
export const PUBLIC_PROMPT_COUNT = 5;

export const PUBLIC_COUNTRY: Record<ReportLanguage, string> = { mk: 'Северна Македонија', en: 'North Macedonia' };

export interface NamedBusiness {
  name: string;
  /** Answers whose lists named it (one count per answer). */
  mentions: number;
}

/** Headings that show up as list items in answers but are not businesses. */
const GENERIC_HEAD =
  /^(?:tips?|notes?|why|how|what|where|when|location|price|prices|pricing|reviews?|ratings?|services?|contact|address|phone|website|hours|pros|cons|summary|conclusion|recommendation|recommendations|bonus|other|also|alternatives?|consider|look for|check|ask|compare|совет|совети|забелешка|зошто|како|што|каде|кога|локација|цена|цени|рецензии|оцени|услуги|контакт|адреса|телефон|веб|работно|предности|недостатоци|заклучок|препорака|препораки|друго|исто така|алтернативи|проверете|споредете|прашајте|побарајте)(?![\p{L}\p{N}])/iu;

function cleanHead(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/^["'„“”«»]+|["'„“”«».,:;!–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const nameKey = (name: string) =>
  brandTokens(name)
    .map((t) => t.key)
    .join('');

/**
 * Businesses the answers listed, other than the business itself. Read from the name part of list
 * items (bold text, link text or text before " – " / ":"), so it works without a competitor list.
 * Heuristic: a heading such as "Tips" can slip through, so it is shown as "named by AI", not as
 * verified competitors.
 */
export function namedBusinesses(answers: EngineAnswer[], business: Pick<BusinessInput, 'name' | 'aliases' | 'domain'>, limit = 5): NamedBusiness[] {
  const target = { name: business.name, aliases: business.aliases, domain: normalizeDomain(business.domain) };
  const found = new Map<string, { name: string; mentions: number; first: number }>();
  let order = 0;
  for (const answer of answers) {
    if (!answer.ok) continue;
    const seen = new Set<string>();
    for (const list of extractLists(answer.text)) {
      for (const item of list) {
        const name = cleanHead(itemHead(item.text));
        if (name.length < 2 || name.length > 60 || name.split(' ').length > 6) continue;
        if (name.includes('?') || !/^[\p{Lu}\p{N}]/u.test(name) || GENERIC_HEAD.test(name)) continue;
        if (mentions(name, target)) continue;
        const key = nameKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const entry = found.get(key);
        if (entry) entry.mentions += 1;
        else found.set(key, { name, mentions: 1, first: order++ });
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.mentions - a.mentions || a.first - b.first)
    .slice(0, limit)
    .map(({ name, mentions: count }) => ({ name, mentions: count }));
}

/** Competitor list fed back into the analysis, so share of voice and per-prompt competitors work. */
export function competitorsFromAnswers(answers: EngineAnswer[], business: BusinessInput): string[] {
  return namedBusinesses(answers, business, LIMITS.competitors).map((n) => n.name.slice(0, LIMITS.competitor));
}

export interface PublicFix {
  title: string;
  why: string;
}

export interface PublicSummary {
  /** Row id in public_checks; null when the result could not be saved (no unlock possible). */
  checkId: string | null;
  /** "no-answer" when no AI answer came back: there is no visibility score, only the website part. */
  status: 'ok' | 'no-answer';
  cached: boolean;
  lang: ReportLanguage;
  checkedAt: string;
  business: { name: string; domain: string; category: string; city: string };
  visibility: { score: number | null; band: ScoreBreakdown['band']; bandText: string };
  readiness: { score: number | null };
  mentions: { count: number; answered: number; total: number };
  competitors: NamedBusiness[];
  topFixes: PublicFix[];
}

function firstFixes(report: VisibilityReport, lang: ReportLanguage, n: number): PublicFix[] {
  const todo = report.recommendations.filter((r) => r.status === 'todo');
  if (todo.length > 0) return todo.slice(0, n).map((r) => ({ title: r.title[lang], why: r.why[0]?.[lang] ?? '' }));
  // No AI answer means no recommendations; fall back to the failed website checks.
  return report.readiness.checks
    .filter((c) => c.state === 'fail')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((c) => ({ title: c.label[lang], why: c.detail[lang] }));
}

function competitorRows(report: VisibilityReport): NamedBusiness[] {
  return report.shareOfVoice.filter((r) => !r.isYou && r.mentions > 0).map((r) => ({ name: r.name, mentions: r.mentions }));
}

export function buildPublicSummary(report: VisibilityReport, opts: { checkId: string | null; lang: ReportLanguage; cached?: boolean }): PublicSummary {
  const { lang } = opts;
  const noAnswer = report.score.answered === 0;
  return {
    checkId: opts.checkId,
    status: noAnswer ? 'no-answer' : 'ok',
    cached: opts.cached ?? false,
    lang,
    checkedAt: report.generatedAt,
    business: { name: report.business.name, domain: report.business.domain, category: report.business.category, city: report.business.city },
    visibility: { score: noAnswer ? null : report.score.score, band: report.score.band, bandText: BAND_TEXT[report.score.band][lang] },
    readiness: { score: report.readiness.score },
    mentions: { count: report.score.mentionedCount, answered: report.score.answered, total: report.prompts.length },
    competitors: competitorRows(report),
    topFixes: firstFixes(report, lang, 3),
  };
}

export interface PublicPromptRow {
  prompt: string;
  answered: boolean;
  mentioned: boolean;
  position: number | null;
  competitors: string[];
}

export interface PublicRecommendation {
  id: string;
  title: string;
  why: string[];
  steps: string[];
  priority: Priority;
  priorityText: string;
  status: 'todo' | 'done';
}

export interface PublicReadinessCheck {
  id: string;
  label: string;
  state: ReadinessCheck['state'];
  stateText: string;
  detail: string;
}

export interface PublicFullReport extends Omit<PublicSummary, 'topFixes' | 'cached'> {
  prompts: PublicPromptRow[];
  recommendations: PublicRecommendation[];
  readinessChecks: PublicReadinessCheck[];
  /** Why the website part is missing, when it is ("The site did not respond in time."). */
  auditError: string | null;
  drafts: { schema: string; llmsTxt: string };
}

export function buildPublicFullReport(report: VisibilityReport, opts: { checkId: string; lang: ReportLanguage }): PublicFullReport {
  const { lang } = opts;
  const summary: Partial<PublicSummary> = buildPublicSummary(report, { checkId: opts.checkId, lang });
  delete summary.topFixes;
  delete summary.cached;
  return {
    ...(summary as Omit<PublicSummary, 'topFixes' | 'cached'>),
    prompts: report.analyses.map((a) => ({
      prompt: a.prompt,
      answered: a.ok,
      mentioned: a.mentioned,
      position: a.position,
      competitors: a.competitors.map((c) => c.name),
    })),
    recommendations: report.recommendations.map((r) => ({
      id: r.id,
      title: r.title[lang],
      why: r.why.map((w) => w[lang]),
      steps: r.steps.map((s) => s[lang]),
      priority: r.priority,
      priorityText: (r.status === 'done' ? PRIORITY_TEXT.done : PRIORITY_TEXT[r.priority])[lang],
      status: r.status,
    })),
    readinessChecks: report.readiness.checks.map((c) => ({
      id: c.id,
      label: c.label[lang],
      state: c.state,
      stateText: CHECK_STATE_TEXT[c.state][lang],
      detail: c.detail[lang],
    })),
    auditError: report.auditError,
    drafts: {
      schema: schemaDraft(report.business, null, report.audit),
      llmsTxt: llmsTxtDraft(report.business, null, report.audit),
    },
  };
}
