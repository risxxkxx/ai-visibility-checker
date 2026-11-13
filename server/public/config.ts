/**
 * Settings for the public mini test (POST /api/public/check, /api/public/lead).
 * Separate from the internal tool: no access code, but Turnstile, CORS allow-list and
 * per-IP / monthly limits kept in Supabase. Everything fails closed when a setting is missing.
 */
import { createHash } from 'node:crypto';

type Env = Record<string, string | undefined>;

export const DEFAULT_ALLOWED_ORIGINS = 'https://agencynula.com,https://www.agencynula.com';
export const DEFAULT_PUBLIC_MONTHLY_CHECKS = 150;
export const PER_IP_DAILY_CHECKS = 3;
export const PER_IP_DAILY_LEADS = 10;
/** A check for the same domain and language within this many days is answered from the cache. */
export const CACHE_DAYS = 7;
/** Netlify stops synchronous functions at 30 s; everything is planned to finish before this. */
export const FUNCTION_BUDGET_MS = 25_000;
export const MIN_SALT_LENGTH = 16;

/** Parses PUBLIC_ALLOWED_ORIGINS into normalised origins ("https://agencynula.com"). */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const source = raw === undefined || raw.trim() === '' ? DEFAULT_ALLOWED_ORIGINS : raw;
  const out: string[] = [];
  for (const part of source.split(',')) {
    const value = part.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(url.origin)) out.push(url.origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

/** Hostnames Turnstile may report, derived from the allowed origins. */
export function allowedHostnames(origins: string[]): string[] {
  return [...new Set(origins.map((o) => new URL(o).hostname))];
}

export function publicMonthlyChecks(env: Env): number {
  const raw = env.PUBLIC_MONTHLY_CHECKS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PUBLIC_MONTHLY_CHECKS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100_000) : DEFAULT_PUBLIC_MONTHLY_CHECKS;
}

export interface SupabaseSettings {
  url: string;
  key: string;
}

/** SUPABASE_URL (https) and SUPABASE_SECRET_KEY, or null when either is missing or malformed. */
export function supabaseSettings(env: Env): SupabaseSettings | null {
  const key = env.SUPABASE_SECRET_KEY?.trim() ?? '';
  const raw = env.SUPABASE_URL?.trim() ?? '';
  if (!key || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return { url: url.origin, key };
  } catch {
    return null;
  }
}

export function ipSalt(env: Env): string | null {
  const salt = env.IP_HASH_SALT?.trim() ?? '';
  return salt.length >= MIN_SALT_LENGTH ? salt : null;
}

/** SHA-256(IP + salt) as hex. Raw IPs are never stored or logged. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${ip}${salt}`, 'utf8').digest('hex');
}

/** UTC day, e.g. "2026-11-13". */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function clientIp(req: Request, contextIp: string | undefined): string {
  return contextIp || req.headers.get('x-nf-client-connection-ip') || 'unknown';
}
