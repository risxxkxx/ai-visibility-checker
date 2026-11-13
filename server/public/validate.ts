/** Body validation for the public endpoints. Reuses the internal tool's field limits. */
import { normaliseTargetUrl } from '../audit/ssrf.mjs';
import { normalizeDomain } from '../../src/lib/normalize.ts';
import { LIMITS } from '../../src/lib/validation.ts';
import type { ReportLanguage } from '../../src/lib/types.ts';
import { MAX_TOKEN_LENGTH } from './turnstile.ts';

/** Turnstile tokens can be 2048 characters, so the check body is allowed a bit more than /api/ask. */
export const PUBLIC_CHECK_MAX_BYTES = 4_096;
export const PUBLIC_LEAD_MAX_BYTES = 1_024;
export const EMAIL_MAX = 254;
export const LEAD_NAME_MAX = 80;
export const LEAD_PHONE_MAX = 40;

export interface PublicCheckBody {
  name: string;
  domain: string;
  target: URL;
  category: string;
  city: string;
  lang: ReportLanguage;
  turnstileToken: string;
}

export interface PublicLeadBody {
  checkId: string;
  email: string;
  name: string | null;
  phone: string | null;
  lang: ReportLanguage | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const isLang = (v: unknown): v is ReportLanguage => v === 'mk' || v === 'en';

export async function readJson(req: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  if (Number(req.headers.get('content-length') ?? '0') > maxBytes) return { ok: false, status: 413 };
  try {
    const raw = await req.text();
    if (raw.length > maxBytes) return { ok: false, status: 413 };
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function validateCheckBody(body: unknown): Validated<PublicCheckBody> {
  if (typeof body !== 'object' || body === null) return { ok: false, field: 'body', error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  const text = (key: 'name' | 'category' | 'city', label: string): Validated<string> => {
    const v = clean(b[key]);
    if (!v) return { ok: false, field: key, error: `Enter the ${label}.` };
    if (v.length > LIMITS[key]) return { ok: false, field: key, error: `Keep the ${label} under ${LIMITS[key]} characters.` };
    return { ok: true, value: v };
  };
  const name = text('name', 'business name');
  if (!name.ok) return name;
  const rawDomain = typeof b.domain === 'string' ? b.domain.trim() : '';
  const domain = rawDomain.length > 0 && rawDomain.length <= LIMITS.domain ? normalizeDomain(rawDomain) : '';
  if (!domain) return { ok: false, field: 'domain', error: 'Enter a website like example.mk.' };
  let target: URL;
  try {
    target = normaliseTargetUrl(`https://${domain}/`);
  } catch {
    return { ok: false, field: 'domain', error: 'Enter a website like example.mk.' };
  }
  const category = text('category', 'category');
  if (!category.ok) return category;
  const city = text('city', 'city');
  if (!city.ok) return city;
  if (!isLang(b.lang)) return { ok: false, field: 'lang', error: 'lang must be "mk" or "en".' };
  const token = typeof b.turnstileToken === 'string' ? b.turnstileToken.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, field: 'turnstileToken', error: 'Complete the anti-spam check.' };
  return { ok: true, value: { name: name.value, domain, target, category: category.value, city: city.value, lang: b.lang, turnstileToken: token } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const PHONE_RE = /^[+\d][\d\s()/.-]{4,}$/;

export function validateLeadBody(body: unknown): Validated<PublicLeadBody> {
  if (typeof body !== 'object' || body === null) return { ok: false, field: 'body', error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  const checkId = typeof b.checkId === 'string' ? b.checkId.trim().toLowerCase() : '';
  if (!UUID_RE.test(checkId)) return { ok: false, field: 'checkId', error: 'Unknown check.' };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { ok: false, field: 'email', error: 'Enter a valid e-mail address.' };
  const name = clean(b.name);
  if (name.length > LEAD_NAME_MAX) return { ok: false, field: 'name', error: `Keep the name under ${LEAD_NAME_MAX} characters.` };
  const phone = clean(b.phone);
  if (phone && (phone.length > LEAD_PHONE_MAX || !PHONE_RE.test(phone))) return { ok: false, field: 'phone', error: 'Enter a valid phone number.' };
  if (b.consent !== true) return { ok: false, field: 'consent', error: 'Consent is required.' };
  return { ok: true, value: { checkId, email, name: name || null, phone: phone || null, lang: isLang(b.lang) ? b.lang : null } };
}
