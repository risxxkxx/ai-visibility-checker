import type { Config, Context } from '@netlify/functions';
import type { FetchLike } from '../../server/providers.ts';
import { checkAccess, createFailedAccessLimiter } from '../../server/access.ts';
import { supabaseSettings } from '../../server/public/config.ts';
import { createSupabase, type SupabaseClient } from '../../server/public/supabase.ts';
import { buildPublicFullReport } from '../../src/lib/publicReport.ts';
import type { VisibilityReport } from '../../src/lib/types.ts';

type Env = Record<string, string | undefined>;

export interface OwnerDeps {
  env?: () => Env;
  fetchImpl?: FetchLike;
  supabase?: (env: Env) => SupabaseClient | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

function isReport(value: unknown): value is VisibilityReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<VisibilityReport>;
  return r.version === 2 && Array.isArray(r.analyses) && Array.isArray(r.recommendations) && typeof r.business === 'object' && typeof r.readiness === 'object';
}

/**
 * Owner-only view of the public mini test, behind ACCESS_CODE (x-access-code header):
 *   GET /api/owner/checks          newest checks with the contact details visitors left
 *   GET /api/owner/report?id=UUID  the full report for one check, plus its leads
 * Visitors never see this; they only get the summary from /api/public/check.
 */
export function createOwnerHandler(deps: OwnerDeps = {}) {
  const env = deps.env ?? (() => process.env);
  const fetchImpl: FetchLike = (url, init) => (deps.fetchImpl ?? globalThis.fetch)(url, init);
  const makeDb =
    deps.supabase ??
    ((e: Env) => {
      const s = supabaseSettings(e);
      return s ? createSupabase(s, fetchImpl) : null;
    });
  const failedAccess = createFailedAccessLimiter();

  return async (req: Request, context?: Context): Promise<Response> => {
    if (req.method !== 'GET') return json(405, { error: 'Use GET.', code: 'method' });
    const e = env();
    const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const access = checkAccess(req, e);
    if (!access.ok) {
      if (access.status === 401 && failedAccess.hit(ip) > 0) {
        return json(429, { error: 'Too many wrong access codes. Try again later.', code: 'access_locked' });
      }
      return json(access.status, { error: access.error, code: access.code });
    }
    const db = makeDb(e);
    if (!db) return json(503, { error: 'The database is not configured.', code: 'not_configured' });

    const url = new URL(req.url);
    try {
      if (url.pathname.endsWith('/checks')) {
        return json(200, { checks: await db.listChecks(100) });
      }
      const id = url.searchParams.get('id') ?? '';
      if (!UUID.test(id)) return json(400, { error: 'Missing or invalid check id.', code: 'invalid_input' });
      const check = await db.getCheck(id);
      if (!check || !isReport(check.report)) return json(404, { error: 'This check was not found.', code: 'not_found' });
      const leads = await db.listLeads(check.id);
      return json(200, { report: buildPublicFullReport(check.report, { checkId: check.id, lang: check.lang }), leads });
    } catch {
      return json(503, { error: 'The database did not respond. Try again.', code: 'storage_unavailable' });
    }
  };
}

export default createOwnerHandler();

export const config: Config = { path: ['/api/owner/checks', '/api/owner/report'], method: 'GET' };
