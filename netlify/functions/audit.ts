import type { Config, Context } from '@netlify/functions';
import { normaliseTargetUrl, safeFetch } from '../../server/audit/ssrf.mjs';
import { runPsi, type PsiResult } from '../../server/audit/psi.mjs';
import { guardFailure, runSiteAudit, type AuditFailure, type FetchPage } from '../../server/siteAudit.ts';
import { RateLimiter, sameOrigin } from '../../server/guard.ts';
import { checkAccess, createFailedAccessLimiter } from '../../server/access.ts';
import { blobsCounterStore, monthlyAuditLimit, reserve, type CounterStore } from '../../server/budget.ts';
import { normalizeDomain } from '../../src/lib/normalize.ts';
import { LIMITS } from '../../src/lib/validation.ts';
import type { SiteAudit } from '../../src/lib/types.ts';

export type { FetchPage };
export const AUDIT_MAX_BODY_BYTES = 1_024;
const PSI_TIMEOUT_MS = 20_000;

export type PsiRunner = (url: string, options: { apiKey: string; timeoutMs: number }) => Promise<{ psi: PsiResult | null; reason: string | null }>;

export interface AuditDeps {
  fetchPage?: FetchPage;
  psiRunner?: PsiRunner;
  env?: () => Record<string, string | undefined>;
  now?: () => Date;
  limiter?: RateLimiter;
  store?: CounterStore;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

function failureResponse(f: AuditFailure): Response {
  return json(f.status, { error: f.error, code: f.code, ...(f.httpStatus !== undefined ? { status: f.httpStatus } : {}) });
}

/**
 * POST /api/audit  { domain, pagespeed? }
 * Fetches the home page (SSRF-guarded), /llms.txt, /robots.txt and the sitemap, optionally runs
 * PageSpeed Insights (only when PAGESPEED_API_KEY is set) and returns GEO readiness facts.
 */
export function createAuditHandler(deps: AuditDeps = {}) {
  const fetchPage: FetchPage = deps.fetchPage ?? safeFetch;
  const psiRunner: PsiRunner = deps.psiRunner ?? ((url, opts) => runPsi(url, opts));
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => new Date());
  const limiter = deps.limiter ?? new RateLimiter(12, 15 * 60_000);
  const failedAccess = createFailedAccessLimiter();
  let store = deps.store ?? null;

  return async (req: Request, context?: Context): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'POST' });
    if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed.' });
    const clientIp = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const access = checkAccess(req, env());
    if (!access.ok) {
      if (access.status === 401 && failedAccess.hit(clientIp) > 0) {
        return json(429, { error: 'Too many wrong access codes. Try again later.', code: 'access_locked' });
      }
      return json(access.status, { error: access.error, code: access.code });
    }
    if (Number(req.headers.get('content-length') ?? '0') > AUDIT_MAX_BODY_BYTES) {
      return json(413, { error: 'Request body is too large.' });
    }

    let body: unknown;
    try {
      const raw = await req.text();
      if (raw.length > AUDIT_MAX_BODY_BYTES) return json(413, { error: 'Request body is too large.' });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Body must be valid JSON.' });
    }
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const rawDomain = typeof b.domain === 'string' ? b.domain : '';
    const domain = rawDomain.length <= LIMITS.domain ? normalizeDomain(rawDomain) : '';
    if (!domain) return json(400, { error: 'Enter a valid domain, for example examplestudio.mk.', code: 'invalid_url' });

    let target: URL;
    try {
      target = normaliseTargetUrl(`https://${domain}/`);
    } catch (error) {
      return failureResponse(guardFailure(error));
    }

    const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const wait = limiter.hit(ip);
    if (wait > 0) return json(429, { error: `Too many audits. Try again in ${wait} seconds.` }, { 'retry-after': String(wait) });

    try {
      store ??= blobsCounterStore();
      const r = await reserve(store, ['audit'], () => monthlyAuditLimit(env()), now());
      if (r.allowed.length === 0) {
        return json(429, { error: 'The monthly audit limit has been reached. It resets on the 1st.', code: 'monthly_limit' });
      }
    } catch {
      return json(503, { error: 'The usage counter is unavailable, so audits are paused.', code: 'budget_unavailable' });
    }

    const apiKey = env().PAGESPEED_API_KEY?.trim() ?? '';
    const wantPsi = b.pagespeed !== false;
    const psiStatusFor = (psi: PsiResult | null): SiteAudit['psiStatus'] =>
      !wantPsi ? 'skipped' : !apiKey ? 'not-configured' : psi ? 'ok' : 'failed';
    const psiPromise: Promise<{ psi: PsiResult | null }> =
      wantPsi && apiKey
        ? psiRunner(target.href, { apiKey, timeoutMs: PSI_TIMEOUT_MS }).catch(() => ({ psi: null }))
        : Promise.resolve({ psi: null });

    const outcome = await runSiteAudit({ domain, target, fetchPage, psi: psiPromise, psiStatus: psiStatusFor, now: now() });
    if (!outcome.ok) return failureResponse(outcome);
    return json(200, { audit: outcome.audit });
  };
}

export default createAuditHandler();

export const config: Config = { path: '/api/audit', method: 'POST' };
