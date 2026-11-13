import type { Config, Context } from '@netlify/functions';
import { engineStatuses, loadConfig } from '../../server/config.ts';
import { callEngine, type FetchLike } from '../../server/providers.ts';
import { monthKey, monthlyLimit } from '../../server/budget.ts';
import { runSiteAudit, type AuditOutcome, type FetchPage } from '../../server/siteAudit.ts';
import {
  CACHE_DAYS,
  FUNCTION_BUDGET_MS,
  PER_IP_DAILY_CHECKS,
  allowedHostnames,
  clientIp,
  dayKey,
  hashIp,
  ipSalt,
  parseAllowedOrigins,
  publicMonthlyChecks,
  supabaseSettings,
} from '../../server/public/config.ts';
import { checkOrigin, jsonWith, preflight } from '../../server/public/cors.ts';
import { verifyTurnstile } from '../../server/public/turnstile.ts';
import { createSupabase, type SupabaseClient } from '../../server/public/supabase.ts';
import { PUBLIC_CHECK_MAX_BYTES, readJson, validateCheckBody } from '../../server/public/validate.ts';
import { generatePrompts } from '../../src/lib/prompts.ts';
import { buildReport } from '../../src/lib/report.ts';
import { PUBLIC_COUNTRY, PUBLIC_PROMPT_COUNT, buildPublicSummary, competitorsFromAnswers, type PublicSummary } from '../../src/lib/publicReport.ts';
import type { BusinessInput, EngineAnswer } from '../../src/lib/types.ts';

type Env = Record<string, string | undefined>;

/** Upper bound for the Gemini calls and the website audit, which run side by side. */
export const PUBLIC_ENGINE_TIMEOUT_MS = 18_000;
/** Time kept back after the engines for analysis and saving the row. */
const SAVE_RESERVE_MS = 3_000;
const MIN_ENGINE_MS = 3_000;

export interface PublicCheckDeps {
  env?: () => Env;
  now?: () => Date;
  /** Used for Turnstile, Supabase and Gemini. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** SSRF-guarded page fetch for the website audit. */
  fetchPage?: FetchPage;
  supabase?: (env: Env) => SupabaseClient | null;
  clock?: () => number;
}

function withTimeout(promise: Promise<AuditOutcome>, ms: number): Promise<AuditOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AuditOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 504, code: 'timeout', error: 'The site did not respond in time.' }), ms);
  });
  return Promise.race([promise.catch((): AuditOutcome => ({ ok: false, status: 502, code: 'network', error: 'The site could not be loaded.' })), timeout]).finally(
    () => clearTimeout(timer),
  );
}

/**
 * POST /api/public/check  { name, domain, category, city, lang, turnstileToken }
 * Free mini test for agencynula.com: 5 prompts to Gemini plus the website audit, analysed on the
 * server. Returns only a summary; the full report needs an e-mail (POST /api/public/lead).
 *
 * Order: CORS, body, configuration (fail closed), Turnstile, 7-day cache, limits (per IP per day,
 * public checks per month, Gemini per month; all atomic in Supabase), run, save.
 */
export function createPublicCheckHandler(deps: PublicCheckDeps = {}) {
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? Date.now;
  const fetchImpl: FetchLike = (url, init) => (deps.fetchImpl ?? globalThis.fetch)(url, init);
  const makeDb =
    deps.supabase ??
    ((e: Env) => {
      const s = supabaseSettings(e);
      return s ? createSupabase(s, fetchImpl) : null;
    });

  return async (req: Request, context?: Context): Promise<Response> => {
    const started = clock();
    const e = env();
    const origins = parseAllowedOrigins(e.PUBLIC_ALLOWED_ORIGINS);
    if (req.method === 'OPTIONS') return preflight(req, origins);
    const cors = checkOrigin(req, origins);
    if (!cors.ok) return cors.response;
    const json = jsonWith(cors.headers);
    if (req.method !== 'POST') return json(405, { error: 'Use POST.', code: 'method' }, { allow: 'POST, OPTIONS' });

    const read = await readJson(req, PUBLIC_CHECK_MAX_BYTES);
    if (!read.ok) return json(read.status, { error: read.status === 413 ? 'Request body is too large.' : 'Body must be valid JSON.', code: 'bad_body' });
    const parsed = validateCheckBody(read.body);
    if (!parsed.ok) return json(400, { error: parsed.error, code: 'invalid_input', field: parsed.field });
    const input = parsed.value;

    // Fail closed: without any of these the public test must not run.
    const secret = e.TURNSTILE_SECRET_KEY?.trim() ?? '';
    const salt = ipSalt(e);
    const db = makeDb(e);
    const cfg = loadConfig(e);
    const gemini = cfg.engines.gemini;
    if (!secret || !salt || !db || !gemini) {
      return json(503, { error: 'The free test is not available right now.', code: 'not_configured' });
    }

    const ip = clientIp(req, context?.ip);
    const turnstile = await verifyTurnstile({ secret, token: input.turnstileToken, ip, allowedHostnames: allowedHostnames(origins), fetchImpl });
    if (!turnstile.ok) {
      if (turnstile.reason === 'unavailable') return json(503, { error: 'The anti-spam check is unavailable. Try again in a minute.', code: 'turnstile_unavailable' });
      return json(403, { error: 'The anti-spam check failed. Reload the page and try again.', code: 'turnstile_failed' });
    }

    const ipHash = hashIp(ip, salt);
    const today = now();
    const month = monthKey(today);
    const perIpKey = `pub:ip:${ipHash}:${dayKey(today)}`;
    const tooMany = () => json(429, { error: 'You have used today’s free checks. Try again tomorrow.', code: 'daily_limit' });
    const counterDown = () => json(503, { error: 'The free test is paused for a moment. Try again later.', code: 'counter_unavailable' });

    // Cache: same domain and language within 7 days answers from the saved summary, with no
    // engine calls and no monthly counters. A different visitor still uses one of their daily
    // checks (so cached results can't be read for free in bulk); the same visitor re-running
    // their own domain does not.
    const since = new Date(today.getTime() - CACHE_DAYS * 24 * 60 * 60_000).toISOString();
    // A broken cache only costs a fresh run; the counters below still fail closed.
    const cached = await db.findRecentCheck(input.domain, input.lang, since).catch(() => null);
    if (cached && typeof cached.summary === 'object' && cached.summary !== null) {
      if (cached.ip_hash !== ipHash) {
        try {
          if (!(await db.incrementUsage(perIpKey, PER_IP_DAILY_CHECKS))) return tooMany();
        } catch {
          return counterDown();
        }
      }
      const summary = { ...(cached.summary as PublicSummary), checkId: cached.id, cached: true };
      return json(200, summary);
    }

    let allowedPrompts: number;
    try {
      if (!(await db.incrementUsage(perIpKey, PER_IP_DAILY_CHECKS))) return tooMany();
      if (!(await db.incrementUsage(`pub:checks:${month}`, publicMonthlyChecks(e)))) {
        return json(429, { error: 'This month’s free checks are used up. Call us on 073 745 473 instead.', code: 'monthly_limit' });
      }
      // One Gemini request per prompt, counted like the internal tool (MONTHLY_LIMIT_GEMINI).
      const geminiLimit = monthlyLimit('gemini', e);
      const reserved = await Promise.all(
        Array.from({ length: PUBLIC_PROMPT_COUNT }, () => db.incrementUsage(`engine:gemini:${month}`, geminiLimit)),
      );
      allowedPrompts = reserved.filter(Boolean).length;
    } catch {
      return counterDown();
    }
    if (allowedPrompts === 0) {
      return json(429, { error: 'This month’s free checks are used up. Call us on 073 745 473 instead.', code: 'monthly_limit' });
    }

    const business: BusinessInput = {
      name: input.name,
      aliases: [],
      domain: input.domain,
      category: input.category,
      city: input.city,
      country: PUBLIC_COUNTRY[input.lang],
      competitors: [],
      language: input.lang,
    };
    const prompts = generatePrompts(business, PUBLIC_PROMPT_COUNT).slice(0, allowedPrompts);
    const remaining = started + FUNCTION_BUDGET_MS - clock() - SAVE_RESERVE_MS;
    const budget = Math.max(MIN_ENGINE_MS, Math.min(PUBLIC_ENGINE_TIMEOUT_MS, cfg.timeoutMs, remaining));
    const engineCfg = { ...cfg, timeoutMs: budget };

    const auditPromise = withTimeout(
      runSiteAudit({ domain: input.domain, target: input.target, fetchPage: deps.fetchPage, psi: null, psiStatus: () => 'skipped', now: today }),
      budget,
    );
    const answersPromise = Promise.allSettled(prompts.map((p) => callEngine(gemini, p, engineCfg, fetchImpl)));
    const [settled, auditOutcome] = await Promise.all([answersPromise, auditPromise]);
    const answers: EngineAnswer[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { engine: 'gemini', model: gemini.model, prompt: prompts[i]!, ok: false, text: '', citations: [], error: 'Unexpected error', latencyMs: 0 },
    );

    const report = buildReport({
      business: { ...business, competitors: competitorsFromAnswers(answers, business) },
      prompts,
      engines: engineStatuses(cfg).filter((s) => s.id === 'gemini'),
      answers,
      demo: false,
      generatedAt: today.toISOString(),
      audit: auditOutcome.ok ? auditOutcome.audit : null,
      auditStatus: auditOutcome.ok ? 'done' : 'failed',
      auditError: auditOutcome.ok ? null : auditOutcome.error,
    });
    const summary = buildPublicSummary(report, { checkId: null, lang: input.lang });

    // A run where no engine answered is saved with no visibility score (never a real 0) and is
    // never served from the cache, so the next try runs again.
    let checkId: string | null;
    try {
      checkId = await db.insertCheck({
        domain: input.domain,
        business_name: input.name,
        category: input.category,
        city: input.city,
        lang: input.lang,
        visibility_score: summary.visibility.score,
        readiness_score: summary.readiness.score,
        answered: report.score.answered,
        summary,
        report,
        ip_hash: ipHash,
      });
    } catch {
      checkId = null; // the visitor still sees the result; only the e-mail unlock is unavailable
    }
    return json(200, { ...summary, checkId });
  };
}

export default createPublicCheckHandler();

export const config: Config = { path: '/api/public/check', method: ['POST', 'OPTIONS'] };
