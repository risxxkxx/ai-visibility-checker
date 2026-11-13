import { createHash, timingSafeEqual } from 'node:crypto';
import { RateLimiter } from './guard.ts';

type Env = Record<string, string | undefined>;

export type AccessResult = { ok: true } | { ok: false; status: number; error: string; code: string };

/** Header the browser sends with the code the owner typed in. */
export const ACCESS_HEADER = 'x-access-code';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Live runs and audits spend the owner's API credit, so they need ACCESS_CODE.
 * No code configured means live calls are refused (fail closed), never open to everyone.
 * Comparison is constant-time over SHA-256 digests, so length and content don't leak.
 */
export function checkAccess(req: Request, env: Env = process.env): AccessResult {
  const expected = env.ACCESS_CODE?.trim() ?? '';
  if (expected.length < 8) {
    return {
      ok: false,
      status: 503,
      code: 'access_not_configured',
      error: 'Live checks are locked: set ACCESS_CODE (at least 8 characters) in the Netlify environment variables.',
    };
  }
  const given = req.headers.get(ACCESS_HEADER)?.trim() ?? '';
  if (!given) return { ok: false, status: 401, code: 'access_required', error: 'Enter the access code to run live checks.' };
  if (given.length > 200 || !timingSafeEqual(digest(given), digest(expected))) {
    return { ok: false, status: 401, code: 'access_denied', error: 'Wrong access code.' };
  }
  return { ok: true };
}

/** Slows down guessing: at most 10 wrong codes per IP per 15 minutes. */
export function createFailedAccessLimiter() {
  return new RateLimiter(10, 15 * 60_000);
}
