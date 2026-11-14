import type { Config, Context } from '@netlify/functions';
import type { FetchLike } from '../../server/providers.ts';
import { PER_IP_DAILY_LEADS, clientIp, dayKey, hashIp, ipSalt, parseAllowedOrigins, supabaseSettings } from '../../server/public/config.ts';
import { checkOrigin, jsonWith, preflight } from '../../server/public/cors.ts';
import { createSupabase, type SupabaseClient } from '../../server/public/supabase.ts';
import { consentRecord } from '../../server/public/consent.ts';
import { PUBLIC_LEAD_MAX_BYTES, readJson, validateLeadBody } from '../../server/public/validate.ts';
import type { VisibilityReport } from '../../src/lib/types.ts';

type Env = Record<string, string | undefined>;

export interface PublicLeadDeps {
  env?: () => Env;
  now?: () => Date;
  fetchImpl?: FetchLike;
  supabase?: (env: Env) => SupabaseClient | null;
}

function isReport(value: unknown): value is VisibilityReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<VisibilityReport>;
  return r.version === 2 && Array.isArray(r.analyses) && Array.isArray(r.recommendations) && typeof r.business === 'object' && typeof r.readiness === 'object';
}

/**
 * POST /api/public/lead  { checkId, email, name?, phone?, consent: true, lang? }
 * Stores the lead (with the exact consent text). The visitor gets a confirmation only; the full
 * report is for the owner (GET /api/owner/report). Sending the same e-mail twice is fine.
 */
export function createPublicLeadHandler(deps: PublicLeadDeps = {}) {
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => new Date());
  const fetchImpl: FetchLike = (url, init) => (deps.fetchImpl ?? globalThis.fetch)(url, init);
  const makeDb =
    deps.supabase ??
    ((e: Env) => {
      const s = supabaseSettings(e);
      return s ? createSupabase(s, fetchImpl) : null;
    });

  return async (req: Request, context?: Context): Promise<Response> => {
    const e = env();
    const origins = parseAllowedOrigins(e.PUBLIC_ALLOWED_ORIGINS);
    if (req.method === 'OPTIONS') return preflight(req, origins);
    const cors = checkOrigin(req, origins);
    if (!cors.ok) return cors.response;
    const json = jsonWith(cors.headers);
    if (req.method !== 'POST') return json(405, { error: 'Use POST.', code: 'method' }, { allow: 'POST, OPTIONS' });

    const read = await readJson(req, PUBLIC_LEAD_MAX_BYTES);
    if (!read.ok) return json(read.status, { error: read.status === 413 ? 'Request body is too large.' : 'Body must be valid JSON.', code: 'bad_body' });
    const parsed = validateLeadBody(read.body);
    if (!parsed.ok) return json(400, { error: parsed.error, code: parsed.field === 'consent' ? 'consent_required' : 'invalid_input', field: parsed.field });
    const lead = parsed.value;

    const salt = ipSalt(e);
    const db = makeDb(e);
    if (!salt || !db) return json(503, { error: 'The report is not available right now.', code: 'not_configured' });

    const ipHash = hashIp(clientIp(req, context?.ip), salt);
    try {
      if (!(await db.incrementUsage(`pub:lead:${ipHash}:${dayKey(now())}`, PER_IP_DAILY_LEADS))) {
        return json(429, { error: 'Too many requests today. Call us on 073 745 473.', code: 'daily_limit' });
      }
    } catch {
      return json(503, { error: 'The report is not available right now. Try again later.', code: 'counter_unavailable' });
    }

    let check;
    try {
      check = await db.getCheck(lead.checkId);
    } catch {
      return json(503, { error: 'The report is not available right now. Try again later.', code: 'storage_unavailable' });
    }
    if (!check || !isReport(check.report)) return json(404, { error: 'This check was not found. Run the test again.', code: 'not_found' });

    let outcome: 'created' | 'duplicate';
    try {
      outcome = await db.insertLead({
        check_id: check.id,
        email: lead.email,
        name: lead.name,
        phone: lead.phone,
        consent: true,
        consent_text: consentRecord(lead.lang ?? check.lang),
      });
    } catch {
      return json(503, { error: 'Your details could not be saved. Try again later.', code: 'storage_unavailable' });
    }

    return json(200, { ok: true, duplicate: outcome === 'duplicate' });
  };
}

export default createPublicLeadHandler();

export const config: Config = { path: '/api/public/lead', method: ['POST', 'OPTIONS'] };
