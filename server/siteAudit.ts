/**
 * Website audit internals shared by POST /api/audit (internal tool) and POST /api/public/check.
 * Fetches the home page (SSRF-guarded), /llms.txt, /robots.txt and the sitemap, optionally waits for
 * PageSpeed, and turns it all into a SiteAudit. Never throws: failures come back as fixed messages.
 */
import { GuardError, safeFetch, type SafeFetchOptions, type SafeFetchResult } from './audit/ssrf.mjs';
import type { PsiResult } from './audit/psi.mjs';
import { buildSiteAudit, type SideFetch } from './geo.ts';
import type { SiteAudit } from '../src/lib/types.ts';

export type FetchPage = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;

const SIDE_FETCH = { timeoutMs: 5_000, maxBytes: 64 * 1024 } as const;

/** English messages for guard error codes. The ported guard's own messages are Macedonian. */
export const GUARD_ERRORS: Record<string, [status: number, message: string]> = {
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

export interface AuditFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  /** Upstream HTTP status, for code "http_status". */
  httpStatus?: number;
}

export type AuditOutcome = { ok: true; audit: SiteAudit } | AuditFailure;

export function guardFailure(error: unknown): AuditFailure {
  const code = error instanceof GuardError ? error.code : 'network';
  const [status, error_] = GUARD_ERRORS[code] ?? GUARD_ERRORS.network!;
  return { ok: false, status, code, error: error_ };
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

export interface RunAuditInput {
  /** Normalised domain, e.g. "examplestudio.mk". */
  domain: string;
  /** Target URL already checked by normaliseTargetUrl. */
  target: URL;
  fetchPage?: FetchPage;
  /** PageSpeed result promise (already started), or null when PageSpeed is not wanted. */
  psi?: Promise<{ psi: PsiResult | null }> | null;
  psiStatus: (psi: PsiResult | null) => SiteAudit['psiStatus'];
  now: Date;
}

export async function runSiteAudit(input: RunAuditInput): Promise<AuditOutcome> {
  const fetchPage = input.fetchPage ?? safeFetch;
  const psiPromise = input.psi ?? Promise.resolve({ psi: null });
  const { domain, target } = input;

  let page: SafeFetchResult;
  try {
    page = await fetchPage(target.href, { accept: 'html' });
  } catch (error) {
    const code = error instanceof GuardError ? error.code : 'network';
    if (code !== 'network' && code !== 'timeout') return guardFailure(error);
    // Some small-business sites still have no TLS; fall back to plain http once.
    try {
      page = await fetchPage(`http://${domain}/`, { accept: 'html' });
    } catch (fallbackError) {
      return guardFailure(fallbackError);
    }
  }

  if (page.skipped === 'content-type' || page.body === null) {
    return { ok: false, status: 422, code: 'not_html', error: 'The address does not return an HTML page.' };
  }
  if (page.status >= 400) {
    const hint = page.status === 403 || page.status === 429 ? ' The site may block automated checks.' : '';
    return { ok: false, status: 422, code: 'http_status', error: `The site returned HTTP ${page.status}.${hint}`, httpStatus: page.status };
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
    psiStatus: input.psiStatus(psiResult.psi),
    now: input.now,
  });
  return { ok: true, audit };
}
