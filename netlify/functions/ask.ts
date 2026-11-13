import type { Config, Context } from '@netlify/functions';
import { loadConfig } from '../../server/config.ts';
import { MAX_BODY_BYTES, MAX_PROMPTS_PER_RUN, RateLimiter, sameOrigin, validateAskBody } from '../../server/guard.ts';
import { callEngine } from '../../server/providers.ts';
import { checkAccess, createFailedAccessLimiter } from '../../server/access.ts';
import { blobsCounterStore, monthlyLimit, reserve, type CounterStore } from '../../server/budget.ts';
import type { EngineAnswer, EngineId } from '../../src/lib/types.ts';

export interface AskDeps {
  store?: CounterStore;
  env?: () => Record<string, string | undefined>;
  now?: () => Date;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });

/**
 * POST /api/ask  { prompt, engines, runId }
 * Sends one prompt to the selected engines in parallel and returns the raw answers.
 * Analysis happens in the browser with the same code the tests cover.
 */
export function createAskHandler(deps: AskDeps = {}) {
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => new Date());
  const cfg = loadConfig(env());
  const perIp = new RateLimiter(cfg.rateLimitRequests, cfg.rateLimitWindowMs);
  const perRun = new RateLimiter(MAX_PROMPTS_PER_RUN, 60 * 60_000);
  const failedAccess = createFailedAccessLimiter();
  let store = deps.store ?? null;

  return async (req: Request, context: Context) => {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'POST' });
    if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed.' });

    const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const access = checkAccess(req, env());
    if (!access.ok) {
      if (access.status === 401 && failedAccess.hit(ip) > 0) {
        return json(429, {
          error: 'Too many wrong access codes. Try again later.',
          code: 'access_locked',
        });
      }
      return json(access.status, { error: access.error, code: access.code });
    }

    const length = Number(req.headers.get('content-length') ?? '0');
    if (length > MAX_BODY_BYTES) return json(413, { error: 'Request body is too large.' });

    let body: unknown;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Request body is too large.' });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Body must be valid JSON.' });
    }

    const parsed = validateAskBody(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const { prompt, engines, runId } = parsed.value;

    const wait = perIp.hit(ip);
    if (wait > 0) {
      return json(429, { error: `Too many requests. Try again in ${wait} seconds.` }, { 'retry-after': String(wait) });
    }
    if (perRun.hit(`${ip}:${runId}`) > 0) {
      return json(429, {
        error: `A run can have at most ${MAX_PROMPTS_PER_RUN} prompts.`,
      });
    }

    const requested = engines.filter((e) => cfg.engines[e]);
    if (requested.length === 0)
      return json(400, {
        error: 'None of the requested engines is configured.',
      });

    let configured: EngineId[];
    let capped: EngineId[];
    try {
      store ??= blobsCounterStore();
      const r = await reserve(store, requested, (e) => monthlyLimit(e, env()), now());
      configured = r.allowed;
      capped = r.blocked;
    } catch {
      // Fail closed: without a working counter the monthly cap can't be enforced.
      return json(503, {
        error: 'The usage counter is unavailable, so live checks are paused.',
        code: 'budget_unavailable',
      });
    }
    if (configured.length === 0) {
      return json(429, {
        error: 'The monthly limit for the selected engines has been reached. It resets on the 1st.',
        code: 'monthly_limit',
      });
    }

    const settled = await Promise.allSettled(configured.map((e) => callEngine(cfg.engines[e]!, prompt, cfg)));
    const answers: EngineAnswer[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            engine: configured[i]!,
            model: cfg.engines[configured[i]!]!.model,
            prompt,
            ok: false,
            text: '',
            citations: [],
            error: 'Unexpected error',
            latencyMs: 0,
          },
    );
    const cappedAnswers: EngineAnswer[] = capped.map((engine) => ({
      engine,
      model: cfg.engines[engine]!.model,
      prompt,
      ok: false,
      text: '',
      citations: [],
      error: 'Monthly limit reached for this engine (resets on the 1st).',
      latencyMs: 0,
    }));
    return json(200, { answers: [...answers, ...cappedAnswers] });
  };
}

export default createAskHandler();

export const config: Config = { path: '/api/ask', method: 'POST' };
