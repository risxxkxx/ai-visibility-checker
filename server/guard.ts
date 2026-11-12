import type { EngineId } from '../src/lib/types.ts';
import { ENGINE_IDS } from '../src/lib/types.ts';
import { MAX_PROMPT_COUNT } from '../src/lib/prompts.ts';
import { MAX_PROMPT_LENGTH } from '../src/lib/limits.ts';

export { MAX_PROMPT_LENGTH };
export const MAX_BODY_BYTES = 4_096;
export const MAX_ENGINES = ENGINE_IDS.length;
export const MAX_PROMPTS_PER_RUN = MAX_PROMPT_COUNT;

export interface AskRequest {
  prompt: string;
  engines: EngineId[];
  runId: string;
}

export type ValidationResult = { ok: true; value: AskRequest } | { ok: false; error: string };

/** Validates the body of POST /api/ask. One prompt per request; the browser fans out. */
export function validateAskBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== 'string') return { ok: false, error: 'prompt must be a string.' };
  const prompt = b.prompt.replace(/\s+/g, ' ').trim();
  if (prompt.length < 3) return { ok: false, error: 'prompt is too short.' };
  if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters.` };

  if (!Array.isArray(b.engines) || b.engines.length === 0) return { ok: false, error: 'engines must be a non-empty array.' };
  if (b.engines.length > MAX_ENGINES) return { ok: false, error: `At most ${MAX_ENGINES} engines per request.` };
  const engines = [...new Set(b.engines)];
  if (!engines.every((e): e is EngineId => typeof e === 'string' && (ENGINE_IDS as readonly string[]).includes(e))) {
    return { ok: false, error: `engines may only contain: ${ENGINE_IDS.join(', ')}.` };
  }

  const runId = typeof b.runId === 'string' ? b.runId : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(runId)) return { ok: false, error: 'runId must be 8-64 letters, digits or dashes.' };

  return { ok: true, value: { prompt, engines, runId } };
}

/**
 * Fixed-window counter kept in memory. It resets when the function instance is recycled and
 * is per instance, so it is a speed bump against casual abuse, not a security boundary.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit. Returns how many seconds to wait if over the limit, otherwise 0. */
  hit(key: string): number {
    const t = this.now();
    if (this.hits.size > 5_000) this.prune(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return 0;
    }
    if (entry.count >= this.limit) return Math.ceil((entry.resetAt - t) / 1000);
    entry.count += 1;
    return 0;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Rejects cross-site browser requests. Requests without an Origin header (curl, server) pass. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
