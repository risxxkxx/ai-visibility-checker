import type { Config, Context } from '@netlify/functions';
import { loadConfig } from '../../server/config.ts';
import { MAX_BODY_BYTES, MAX_PROMPTS_PER_RUN, RateLimiter, sameOrigin, validateAskBody } from '../../server/guard.ts';
import { callEngine } from '../../server/providers.ts';
import type { EngineAnswer } from '../../src/lib/types.ts';

const cfg = loadConfig();
const perIp = new RateLimiter(cfg.rateLimitRequests, cfg.rateLimitWindowMs);
const perRun = new RateLimiter(MAX_PROMPTS_PER_RUN, 60 * 60_000);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/**
 * POST /api/ask  { prompt, engines, runId }
 * Sends one prompt to the selected engines in parallel and returns the raw answers.
 * Analysis happens in the browser with the same code the tests cover.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'POST' });
  if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed.' });

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

  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const wait = perIp.hit(ip);
  if (wait > 0) {
    return json(429, { error: `Too many requests. Try again in ${wait} seconds.` }, { 'retry-after': String(wait) });
  }
  if (perRun.hit(`${ip}:${runId}`) > 0) {
    return json(429, { error: `A run can have at most ${MAX_PROMPTS_PER_RUN} prompts.` });
  }

  const configured = engines.filter((e) => cfg.engines[e]);
  if (configured.length === 0) return json(400, { error: 'None of the requested engines is configured.' });

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
  return json(200, { answers });
};

export const config: Config = { path: '/api/ask', method: 'POST' };
