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

// ---------- shared ----------

const PROVIDERS: Record<
  EngineId,
  { request: (e: EngineConfig, p: string, c: ServerConfig) => ProviderRequest; parse: (d: unknown) => ParsedAnswer }
> = {
  anthropic: { request: anthropicRequest, parse: parseAnthropic },
  openai: { request: openaiRequest, parse: parseOpenAI },
  perplexity: { request: perplexityRequest, parse: parsePerplexity },
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
  detail = detail.replace(/(sk|pplx|key)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 200);
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Calls one engine with a timeout. Never throws: failures come back as ok=false answers. */
export async function callEngine(
  engine: EngineConfig,
  prompt: string,
  cfg: ServerConfig,
  fetchImpl: FetchLike = fetch,
): Promise<EngineAnswer> {
  const provider = PROVIDERS[engine.id];
  const req = provider.request(engine, prompt, cfg);
  const started = Date.now();
  const base = { engine: engine.id, model: engine.model, prompt };
  try {
    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // keep raw text for the error message
    }
    if (!res.ok) {
      return { ...base, ok: false, text: '', citations: [], error: providerErrorMessage(res.status, data), latencyMs: Date.now() - started };
    }
    const parsed = provider.parse(data);
    if (!parsed.text) {
      return { ...base, ok: false, text: '', citations: parsed.citations, error: 'Empty answer', latencyMs: Date.now() - started };
    }
    return { ...base, ok: true, text: parsed.text, citations: parsed.citations, latencyMs: Date.now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const error =
      name === 'TimeoutError' || name === 'AbortError'
        ? `Timed out after ${Math.round(cfg.timeoutMs / 1000)}s`
        : 'Network error';
    return { ...base, ok: false, text: '', citations: [], error, latencyMs: Date.now() - started };
  }
}
