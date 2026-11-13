/**
 * Cloudflare Turnstile server-side validation (siteverify).
 *
 * Response shape: { success, challenge_ts, hostname, "error-codes": string[], action, cdata, metadata }.
 * Tokens are single-use, valid for 300 s and at most 2048 characters. We additionally require the
 * hostname to be one of ours and the action to match the widget's action ("ai-check").
 */
import { randomUUID } from 'node:crypto';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'ai-check';
export const MAX_TOKEN_LENGTH = 2048;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: 'missing-token' | 'rejected' | 'hostname' | 'action' | 'unavailable'; codes: string[] };

export interface VerifyInput {
  secret: string;
  token: string;
  ip: string;
  allowedHostnames: string[];
  action?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export async function verifyTurnstile(input: VerifyInput): Promise<TurnstileResult> {
  const token = input.token.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'missing-token', codes: [] };
  const form = new URLSearchParams({
    secret: input.secret,
    response: token,
    idempotency_key: input.idempotencyKey ?? randomUUID(),
  });
  if (input.ip && input.ip !== 'unknown') form.set('remoteip', input.ip);

  let data: Record<string, unknown>;
  try {
    const res = await (input.fetchImpl ?? fetch)(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable', codes: [`http-${res.status}`] };
    const parsed: unknown = await res.json();
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'unavailable', codes: ['bad-json'] };
    data = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'unavailable', codes: ['network'] };
  }

  const codes = Array.isArray(data['error-codes']) ? data['error-codes'].filter((c): c is string => typeof c === 'string') : [];
  if (data.success !== true) {
    // Cloudflare's own outage is "internal-error"; everything else means the token is bad.
    return { ok: false, reason: codes.includes('internal-error') ? 'unavailable' : 'rejected', codes };
  }
  const hostname = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : '';
  if (!input.allowedHostnames.includes(hostname)) return { ok: false, reason: 'hostname', codes };
  if (data.action !== (input.action ?? TURNSTILE_ACTION)) return { ok: false, reason: 'action', codes };
  return { ok: true };
}
