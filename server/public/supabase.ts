/**
 * Minimal Supabase access over PostgREST with plain fetch (no SDK), server-side only.
 * The tables have RLS on and no policies, so only the secret key can read or write them.
 * Every call has a timeout. Errors never contain the key or the upstream body.
 */
import type { SupabaseSettings } from './config.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'SupabaseError';
  }
}

export interface PublicCheckInsert {
  domain: string;
  business_name: string;
  category: string;
  city: string;
  lang: 'mk' | 'en';
  visibility_score: number | null;
  readiness_score: number | null;
  answered: number;
  summary: unknown;
  report: unknown;
  ip_hash: string;
}

export interface CachedCheck {
  id: string;
  created_at: string;
  ip_hash: string | null;
  summary: unknown;
}

export interface StoredCheck {
  id: string;
  created_at: string;
  lang: 'mk' | 'en';
  domain: string;
  report: unknown;
}

export interface LeadInsert {
  check_id: string;
  email: string;
  name: string | null;
  phone: string | null;
  consent: true;
  consent_text: string;
}

export interface SupabaseClient {
  /** Atomic counter via public.try_increment_usage: true if under the limit (and counted). */
  incrementUsage(key: string, limit: number): Promise<boolean>;
  findRecentCheck(domain: string, lang: 'mk' | 'en', sinceIso: string): Promise<CachedCheck | null>;
  insertCheck(row: PublicCheckInsert): Promise<string>;
  getCheck(id: string): Promise<StoredCheck | null>;
  /** "duplicate" when (check_id, lower(email)) already exists. */
  insertLead(row: LeadInsert): Promise<'created' | 'duplicate'>;
}

/** Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only in apikey. */
export function supabaseHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json', accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return headers;
}

export function createSupabase(settings: SupabaseSettings, fetchImpl: FetchLike = fetch, timeoutMs = 4_000): SupabaseClient {
  const rest = `${settings.url}/rest/v1`;
  const headers = supabaseHeaders(settings.key);

  async function call(path: string, init: { method: string; body?: unknown; prefer?: string }): Promise<{ status: number; data: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${rest}${path}`, {
        method: init.method,
        headers: { ...headers, ...(init.prefer ? { prefer: init.prefer } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SupabaseError('Database request failed', null);
    }
    const text = await res.text().catch(() => '');
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: res.status, data };
  }

  const ok = (status: number) => status >= 200 && status < 300;

  return {
    async incrementUsage(key, limit) {
      const r = await call('/rpc/try_increment_usage', { method: 'POST', body: { p_key: key, p_limit: limit } });
      if (!ok(r.status) || typeof r.data !== 'boolean') throw new SupabaseError('Usage counter unavailable', r.status);
      return r.data;
    },

    async findRecentCheck(domain, lang, sinceIso) {
      const q = new URLSearchParams({
        select: 'id,created_at,ip_hash,summary',
        domain: `eq.${domain}`,
        lang: `eq.${lang}`,
        answered: 'gt.0',
        created_at: `gte.${sinceIso}`,
        order: 'created_at.desc',
        limit: '1',
      });
      const r = await call(`/public_checks?${q}`, { method: 'GET' });
      if (!ok(r.status) || !Array.isArray(r.data)) throw new SupabaseError('Cache lookup failed', r.status);
      return (r.data[0] as CachedCheck | undefined) ?? null;
    },

    async insertCheck(row) {
      const r = await call('/public_checks?select=id', { method: 'POST', body: row, prefer: 'return=representation' });
      const first = Array.isArray(r.data) ? (r.data[0] as { id?: unknown } | undefined) : undefined;
      if (!ok(r.status) || typeof first?.id !== 'string') throw new SupabaseError('Saving the check failed', r.status);
      return first.id;
    },

    async getCheck(id) {
      const q = new URLSearchParams({ select: 'id,created_at,lang,domain,report', id: `eq.${id}`, limit: '1' });
      const r = await call(`/public_checks?${q}`, { method: 'GET' });
      if (!ok(r.status) || !Array.isArray(r.data)) throw new SupabaseError('Loading the check failed', r.status);
      return (r.data[0] as StoredCheck | undefined) ?? null;
    },

    async insertLead(row) {
      const r = await call('/leads?select=id', { method: 'POST', body: row, prefer: 'return=representation' });
      if (ok(r.status)) return 'created';
      // 409 / 23505: unique (check_id, lower(email)) already exists.
      const code = typeof r.data === 'object' && r.data !== null ? (r.data as { code?: unknown }).code : undefined;
      if (r.status === 409 || code === '23505') return 'duplicate';
      throw new SupabaseError('Saving the lead failed', r.status);
    },
  };
}
