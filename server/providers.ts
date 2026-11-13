import type { EngineAnswer, EngineId } from '../src/lib/types.ts';
import type { EngineConfig, ServerConfig } from './config.ts';

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ParsedAnswer {
  text: string;
  citations: string[];
  /** Why the answer is empty, when the provider says (blocked prompt, token limit). */
  note?: string;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function unique(urls: string[]): string[] {
  return [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
}

// ---------- Anthropic (Messages API) ----------

export function anthropicRequest(engine: EngineConfig, prompt: string, cfg: ServerConfig): ProviderRequest {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': engine.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: {
      model: engine.model,
      max_tokens: cfg.maxOutputTokens,
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

export function parseAnthropic(data: unknown): ParsedAnswer {
  const blocks = isObj(data) ? arr(data.content) : [];
  const text = blocks
    .filter((b) => isObj(b) && b.type === 'text')
    .map((b) => str((b as Json).text))
    .join('\n')
    .trim();
  const citations = blocks.flatMap((b) =>
    isObj(b) ? arr(b.citations).map((c) => (isObj(c) ? str(c.url) : '')) : [],
  );
  return { text, citations: unique(citations) };
}

// ---------- OpenAI (Responses API) ----------

export function openaiRequest(engine: EngineConfig, prompt: string, cfg: ServerConfig): ProviderRequest {
  const body: Json = {
    model: engine.model,
    input: prompt,
    // Reasoning tokens count toward this limit, so leave headroom for them.
    max_output_tokens: cfg.openaiReasoningEffort ? cfg.maxOutputTokens + 1500 : cfg.maxOutputTokens,
    store: false,
  };
  if (cfg.openaiReasoningEffort) body.reasoning = { effort: cfg.openaiReasoningEffort };
  if (cfg.openaiWebSearch) body.tools = [{ type: 'web_search' }];
  return {
    url: 'https://api.openai.com/v1/responses',
    headers: { authorization: `Bearer ${engine.apiKey}`, 'content-type': 'application/json' },
    body,
  };
}

export function parseOpenAI(data: unknown): ParsedAnswer {
  if (!isObj(data)) return { text: '', citations: [] };
  const parts: string[] = [];
  const citations: string[] = [];
  for (const item of arr(data.output)) {
    if (!isObj(item) || item.type !== 'message') continue;
    for (const c of arr(item.content)) {
      if (!isObj(c) || c.type !== 'output_text') continue;
      parts.push(str(c.text));
      for (const a of arr(c.annotations)) {
        if (isObj(a) && a.type === 'url_citation') citations.push(str(a.url));
      }
    }
  }
  const text = (parts.length > 0 ? parts.join('\n') : str(data.output_text)).trim();
  return { text, citations: unique(citations) };
}

// ---------- Perplexity (Sonar) ----------

export function perplexityRequest(engine: EngineConfig, prompt: string, cfg: ServerConfig): ProviderRequest {
  return {
    url: cfg.perplexityUrl,
    headers: { authorization: `Bearer ${engine.apiKey}`, 'content-type': 'application/json' },
    body: {
      model: engine.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: cfg.maxOutputTokens,
    },
  };
}

export function parsePerplexity(data: unknown): ParsedAnswer {
  if (!isObj(data)) return { text: '', citations: [] };
  const first = arr(data.choices)[0];
  const message = isObj(first) && isObj(first.message) ? first.message : {};
  const text = str(message.content).trim();
  const citations = [
    ...arr(data.citations).map(str),
    ...arr(data.search_results).map((r) => (isObj(r) ? str(r.url) : '')),
  ];
  return { text, citations: unique(citations) };
}

// ---------- Google Gemini (generateContent) ----------

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function geminiRequest(engine: EngineConfig, prompt: string, cfg: ServerConfig): ProviderRequest {
  const generationConfig: Json = {
    // Thinking tokens count toward maxOutputTokens, so leave headroom for them.
    maxOutputTokens: cfg.geminiThinkingLevel ? cfg.maxOutputTokens + 1500 : cfg.maxOutputTokens,
  };
  if (cfg.geminiThinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: cfg.geminiThinkingLevel };
  const body: Json = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (cfg.geminiGrounding) body.tools = [{ google_search: {} }];
  return {
    url: `${GEMINI_API_BASE}/models/${encodeURIComponent(engine.model)}:generateContent`,
    headers: { 'x-goog-api-key': engine.apiKey, 'content-type': 'application/json' },
    body,
  };
}

const DOMAIN_TITLE_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Grounding chunk URIs are Google redirect links (vertexaisearch.cloud.google.com/grounding-api-redirect/...)
 * and the chunk title is the source domain. Redirect links expire and all share one host, so they are
 * reduced to https://<domain>/ for source counting. Direct links are kept as they are.
 */
export function geminiCitation(uri: string, title: string): string {
  let host = '';
  try {
    host = new URL(uri).hostname;
  } catch {
    // not a URL
  }
  const isRedirect = host === '' || host === 'vertexaisearch.cloud.google.com';
  if (isRedirect) return DOMAIN_TITLE_RE.test(title.trim()) ? `https://${title.trim().toLowerCase()}/` : '';
  return uri;
}

export function parseGemini(data: unknown): ParsedAnswer {
  if (!isObj(data)) return { text: '', citations: [] };
  const candidate = arr(data.candidates)[0];
  const cand = isObj(candidate) ? candidate : {};
  const content = isObj(cand.content) ? cand.content : {};
  const text = arr(content.parts)
    .filter((p) => isObj(p) && p.thought !== true)
    .map((p) => str((p as Json).text))
    .join('')
    .trim();
  const grounding = isObj(cand.groundingMetadata) ? cand.groundingMetadata : {};
  const citations = arr(grounding.groundingChunks).map((c) => {
    const web = isObj(c) && isObj(c.web) ? c.web : {};
    return geminiCitation(str(web.uri), str(web.title));
  });
  let note: string | undefined;
  if (!text) {
    const feedback = isObj(data.promptFeedback) ? data.promptFeedback : {};
    const blocked = str(feedback.blockReason);
    const finish = str(cand.finishReason);
    if (blocked) note = `Blocked by Gemini (${blocked})`;
    else if (finish === 'MAX_TOKENS') note = 'Stopped at the token limit before answering (raise MAX_OUTPUT_TOKENS or lower GEMINI_THINKING_LEVEL)';
    else if (finish && finish !== 'STOP') note = `Stopped by Gemini (${finish})`;
  }
  return { text, citations: unique(citations), ...(note ? { note } : {}) };
}

// ---------- shared ----------

const PROVIDERS: Record<
  EngineId,
  { request: (e: EngineConfig, p: string, c: ServerConfig) => ProviderRequest; parse: (d: unknown) => ParsedAnswer }
> = {
  anthropic: { request: anthropicRequest, parse: parseAnthropic },
  openai: { request: openaiRequest, parse: parseOpenAI },
  perplexity: { request: perplexityRequest, parse: parsePerplexity },
  gemini: { request: geminiRequest, parse: parseGemini },
};

/** Pulls a readable message out of a provider error body without echoing anything secret. */
export function providerErrorMessage(status: number, body: unknown): string {
  let detail = '';
  if (isObj(body)) {
    const err = body.error;
    detail = isObj(err) ? str(err.message) : str(err) || str(body.message);
  } else if (typeof body === 'string') {
    detail = body;
  }
  detail = detail
    .replace(/(sk|pplx|key)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .slice(0, 200);
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Upstream statuses worth one more try: rate limits and temporary overload ("high demand"). */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type Attempt = { answer: EngineAnswer; retryable: boolean; timedOut: boolean };

async function attemptOnce(
  engine: EngineConfig,
  prompt: string,
  cfg: ServerConfig,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Attempt> {
  const provider = PROVIDERS[engine.id];
  const req = provider.request(engine, prompt, cfg);
  const started = Date.now();
  const base = { engine: engine.id, model: engine.model, prompt };
  try {
    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // keep raw text for the error message
    }
    if (!res.ok) {
      return {
        answer: { ...base, ok: false, text: '', citations: [], error: providerErrorMessage(res.status, data), latencyMs: Date.now() - started },
        retryable: RETRYABLE_STATUSES.has(res.status),
        timedOut: false,
      };
    }
    const parsed = provider.parse(data);
    if (!parsed.text) {
      return {
        answer: { ...base, ok: false, text: '', citations: parsed.citations, error: parsed.note ?? 'Empty answer', latencyMs: Date.now() - started },
        retryable: false,
        timedOut: false,
      };
    }
    return {
      answer: { ...base, ok: true, text: parsed.text, citations: parsed.citations, latencyMs: Date.now() - started },
      retryable: false,
      timedOut: false,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const error = timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : 'Network error';
    return { answer: { ...base, ok: false, text: '', citations: [], error, latencyMs: Date.now() - started }, retryable: !timedOut, timedOut };
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Below this much remaining time another attempt isn't worth starting. */
const MIN_ATTEMPT_MS = 3_000;

/**
 * Calls one engine within cfg.timeoutMs in total. Never throws: failures come back as ok=false answers.
 * On a temporary upstream error (429/5xx, network) it retries once after a short backoff, and for
 * Gemini it then tries GEMINI_FALLBACK_MODEL, because a busy model often answers "high demand" (503)
 * while an older one is free. The answer records the model that actually answered.
 */
export async function callEngine(
  engine: EngineConfig,
  prompt: string,
  cfg: ServerConfig,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<EngineAnswer> {
  const started = Date.now();
  const deadline = started + cfg.timeoutMs;
  const fallback = engine.id === 'gemini' && cfg.geminiFallbackModel !== engine.model ? cfg.geminiFallbackModel : '';
  // With a fallback available, the main model gets ~55% of the budget so a slow ("high demand") model
  // still leaves time for the fallback instead of using up the whole timeout.
  const mainBudget = fallback ? Math.round(cfg.timeoutMs * 0.55) : cfg.timeoutMs;
  const plan: { model: string; backoffMs: number }[] = [
    { model: engine.model, backoffMs: 0 },
    { model: engine.model, backoffMs: 1_200 },
    ...(fallback ? [{ model: fallback, backoffMs: 300 }] : []),
  ];

  let first: EngineAnswer | null = null;
  let skipMain = false;
  for (const [i, step] of plan.entries()) {
    const isMain = step.model === engine.model;
    if (isMain && skipMain) continue;
    if (i > 0) {
      if (deadline - Date.now() - step.backoffMs < MIN_ATTEMPT_MS) break;
      await sleep(step.backoffMs);
    }
    const remaining = deadline - Date.now();
    const budget = Math.max(1_000, isMain ? Math.min(remaining, started + mainBudget - Date.now()) : remaining);
    const { answer, retryable, timedOut } = await attemptOnce({ ...engine, model: step.model }, prompt, cfg, fetchImpl, budget);
    if (answer.ok) return { ...answer, latencyMs: Date.now() - started };
    first ??= answer;
    // A timeout means the model is too slow right now: don't retry it, go to the fallback.
    if (timedOut && isMain) {
      skipMain = true;
      continue;
    }
    if (!retryable) {
      // A non-temporary error from the fallback shouldn't hide the original reason.
      return isMain ? { ...answer, latencyMs: Date.now() - started } : { ...first, latencyMs: Date.now() - started };
    }
  }
  return { ...first!, latencyMs: Date.now() - started };
}
