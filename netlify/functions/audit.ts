import type { Config, Context } from '@netlify/functions';
import { GuardError, normaliseTargetUrl, safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../../server/audit/ssrf.mjs';
import { runPsi, type PsiResult } from '../../server/audit/psi.mjs';
import { buildSiteAudit, type SideFetch } from '../../server/geo.ts';
import { RateLimiter, sameOrigin } from '../../server/guard.ts';
import { normalizeDomain } from '../../src/lib/normalize.ts';
import { LIMITS } from '../../src/lib/validation.ts';
import type { SiteAudit } from '../../src/lib/types.ts';

export const AUDIT_MAX_BODY_BYTES = 1_024;
const SIDE_FETCH = { timeoutMs: 5_000, maxBytes: 64 * 1024 } as const;
const PSI_TIMEOUT_MS = 20_000;

/** English messages for guard error codes. The ported guard's own messages are Macedonian. */
const GUARD_ERRORS: Record<string, [status: number, message: string]> = {
  invalid_url: [400, 'Enter a valid domain, for example examplestudio.mk.'],
  url_too_long: [400, 'The domain is too long.'],
  invalid_scheme: [400, 'Only http and https sites can be audited.'],
  credentials: [400, 'The address must not contain a user name or password.'],
  port: [400, 'Only standard ports (80/443) are allowed.'],
  private_address: [400, 'The domain points to a private or local address, so it was not audited.'],
  dns: [422, 'The domain could not be found (DNS).'],
  invalid_redirect: [422, 'The site sent an invalid redirect.'],
  too_many_redirects: [422, 'The site redirected too many times.'],
  timeout: [504, 'The site did not respond in time.'],
  network: [502, 'The site could not be loaded.'],
};

export type FetchPage = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;
export type PsiRunner = (url: string, options: { apiKey: string; timeoutMs: number }) => Promise<{ psi: PsiResult | null; reason: string | null }>;

export interface AuditDeps {
  fetchPage?: FetchPage;
  psiRunner?: PsiRunner;
  env?: () => Record<string, string | undefined>;
  now?: () => Date;
  limiter?: RateLimiter;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

function guardResponse(error: unknown): Response {
  const code = error instanceof GuardError ? error.code : 'network';
  const [status, message] = GUARD_ERRORS[code] ?? GUARD_ERRORS.network!;
  return json(status, { error: message, code });
}

async function side(fetchPage: FetchPage, url: string): Promise<SideFetch | null> {
  try {
    const r = await fetchPage(url, { accept: 'text', ...SIDE_FETCH });
    return { status: r.status, contentType: r.contentType, body: r.body };
  } catch {
    return null;
  }
}

function robotsSitemap(robots: SideFetch | null): string | null {
  if (!robots || robots.status !== 200 || !robots.body) return null;
  const m = /^\s*sitemap\s*:\s*(https?:\/\/\S+)/im.exec(robots.body);
  return m ? m[1]! : null;
}

async function httpRedirect(page: SafeFetchResult, fetchPage: FetchPage): Promise<boolean | null> {
  const first = new URL(page.redirects[0] ?? page.finalUrl);
  const final = new URL(page.finalUrl);
  if (final.protocol !== 'https:') return null;
  if (first.protocol === 'http:') return true;
  try {
    const r = await fetchPage(`http://${final.host}/`, { accept: 'none', ...SIDE_FETCH });
    return new URL(r.finalUrl).protocol === 'https:';
  } catch {
    return null; // port 80 closed: nothing insecure is served
  }
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

  return async (req: Request, context?: Context): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'POST' });
    if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed.' });
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
      return guardResponse(error);
    }

    const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const wait = limiter.hit(ip);
    if (wait > 0) return json(429, { error: `Too many audits. Try again in ${wait} seconds.` }, { 'retry-after': String(wait) });

    const apiKey = env().PAGESPEED_API_KEY?.trim() ?? '';
    const wantPsi = b.pagespeed !== false;
    const psiStatusFor = (psi: PsiResult | null): SiteAudit['psiStatus'] =>
      !wantPsi ? 'skipped' : !apiKey ? 'not-configured' : psi ? 'ok' : 'failed';
    const psiPromise: Promise<{ psi: PsiResult | null }> =
      wantPsi && apiKey
        ? psiRunner(target.href, { apiKey, timeoutMs: PSI_TIMEOUT_MS }).catch(() => ({ psi: null }))
        : Promise.resolve({ psi: null });

    let page: SafeFetchResult;
    try {
      page = await fetchPage(target.href, { accept: 'html' });
    } catch (error) {
      const code = error instanceof GuardError ? error.code : 'network';
      if (code !== 'network' && code !== 'timeout') return guardResponse(error);
      // Some small-business sites still have no TLS; fall back to plain http once.
      try {
        page = await fetchPage(`http://${domain}/`, { accept: 'html' });
      } catch (fallbackError) {
        return guardResponse(fallbackError);
      }
    }

    if (page.skipped === 'content-type' || page.body === null) {
      return json(422, { error: 'The address does not return an HTML page.', code: 'not_html' });
    }
    if (page.status >= 400) {
      const hint = page.status === 403 || page.status === 429 ? ' The site may block automated checks.' : '';
      return json(422, { error: `The site returned HTTP ${page.status}.${hint}`, code: 'http_status', status: page.status });
    }

    const origin = new URL(page.finalUrl).origin;
    const [redirect, llms, robots, psiResult] = await Promise.all([
      httpRedirect(page, fetchPage),
      side(fetchPage, `${origin}/llms.txt`),
      side(fetchPage, `${origin}/robots.txt`),
      psiPromise,
    ]);
    const declared = robotsSitemap(robots);
    const sitemap = await side(fetchPage, declared?.startsWith(`${origin}/`) ? declared : `${origin}/sitemap.xml`);

    const audit = buildSiteAudit({
      domain,
      html: page.body,
      finalUrl: page.finalUrl,
      bytes: page.bytes,
      truncated: page.truncated,
      httpRedirectsToHttps: redirect,
      llms,
      robots,
      sitemap,
      psi: psiResult.psi,
      psiStatus: psiStatusFor(psiResult.psi),
      now: now(),
    });
    return json(200, { audit });
  };
}

export default createAuditHandler();

export const config: Config = { path: '/api/audit', method: 'POST' };
