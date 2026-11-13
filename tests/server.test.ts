import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, engineStatuses, loadConfig } from '../server/config.ts';
import { RateLimiter, sameOrigin, validateAskBody } from '../server/guard.ts';
import {
  callEngine,
  geminiCitation,
  geminiRequest,
  openaiRequest,
  parseGemini,
  parseAnthropic,
  parseOpenAI,
  parsePerplexity,
  providerErrorMessage,
  type FetchLike,
} from '../server/providers.ts';

describe('loadConfig', () => {
  it('enables only engines with keys and uses default models', () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'k1', PERPLEXITY_API_KEY: ' ', ANTHROPIC_API_KEY: 'k2', ANTHROPIC_MODEL: 'custom' });
    expect(Object.keys(cfg.engines).sort()).toEqual(['anthropic', 'openai']);
    expect(cfg.engines.anthropic!.model).toBe('custom');
    expect(cfg.engines.openai!.model).toBe(DEFAULT_MODELS.openai);
  });

  it('clamps numeric settings', () => {
    const cfg = loadConfig({ ENGINE_TIMEOUT_MS: '999999', MAX_OUTPUT_TOKENS: 'abc' });
    expect(cfg.timeoutMs).toBe(28_000);
    expect(cfg.maxOutputTokens).toBe(900);
  });

  it('never exposes keys in public statuses', () => {
    const statuses = engineStatuses(loadConfig({ OPENAI_API_KEY: 'sk-secret-value' }));
    expect(JSON.stringify(statuses)).not.toContain('sk-secret-value');
    expect(statuses.find((s) => s.id === 'openai')!.available).toBe(true);
    expect(statuses.find((s) => s.id === 'perplexity')!.available).toBe(false);
  });
});

describe('validateAskBody', () => {
  const ok = { prompt: 'best web design agency in Skopje', engines: ['openai'], runId: 'run-12345678' };

  it('accepts all four engines', () => {
    expect(validateAskBody({ ...ok, engines: ['anthropic', 'openai', 'perplexity', 'gemini'] }).ok).toBe(true);
  });

  it('accepts a valid body and normalises whitespace', () => {
    const r = validateAskBody({ ...ok, prompt: '  best   agency  ' });
    expect(r).toEqual({ ok: true, value: { prompt: 'best agency', engines: ['openai'], runId: 'run-12345678' } });
  });

  it('rejects bad input', () => {
    expect(validateAskBody(null).ok).toBe(false);
    expect(validateAskBody({ ...ok, prompt: 'x'.repeat(301) }).ok).toBe(false);
    expect(validateAskBody({ ...ok, prompt: 'hi' }).ok).toBe(false);
    expect(validateAskBody({ ...ok, engines: [] }).ok).toBe(false);
    expect(validateAskBody({ ...ok, engines: ['openai', 'copilot'] }).ok).toBe(false);
    expect(validateAskBody({ ...ok, engines: ['a', 'b', 'c', 'd'] }).ok).toBe(false);
    expect(validateAskBody({ ...ok, engines: ['openai', 'gemini', 'anthropic', 'perplexity', 'x'] }).ok).toBe(false);
    expect(validateAskBody({ ...ok, runId: 'x' }).ok).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window, then reports the wait', () => {
    let t = 0;
    const rl = new RateLimiter(2, 10_000, () => t);
    expect(rl.hit('ip')).toBe(0);
    expect(rl.hit('ip')).toBe(0);
    expect(rl.hit('ip')).toBe(10);
    expect(rl.hit('other')).toBe(0);
    t = 10_001;
    expect(rl.hit('ip')).toBe(0);
  });
});

describe('sameOrigin', () => {
  it('allows same-origin and origin-less requests, blocks others', () => {
    const mk = (origin?: string) =>
      new Request('https://app.test/api/ask', { method: 'POST', headers: origin ? { origin } : {} });
    expect(sameOrigin(mk())).toBe(true);
    expect(sameOrigin(mk('https://app.test'))).toBe(true);
    expect(sameOrigin(mk('https://evil.test'))).toBe(false);
  });
});

describe('response parsers', () => {
  it('parses Anthropic text blocks', () => {
    expect(
      parseAnthropic({ content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use' }, { type: 'text', text: 'there' }] }),
    ).toEqual({ text: 'Hello\nthere', citations: [] });
  });

  it('parses OpenAI Responses output and url citations', () => {
    const data = {
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '1. Example Studio',
              annotations: [{ type: 'url_citation', url: 'https://clutch.co/x' }, { type: 'url_citation', url: 'https://clutch.co/x' }],
            },
          ],
        },
      ],
    };
    expect(parseOpenAI(data)).toEqual({ text: '1. Example Studio', citations: ['https://clutch.co/x'] });
    expect(parseOpenAI({ output_text: 'fallback' }).text).toBe('fallback');
  });

  it('parses Perplexity citations and search_results', () => {
    const data = {
      choices: [{ message: { role: 'assistant', content: 'Answer [1]' } }],
      citations: ['https://a.test/1'],
      search_results: [{ url: 'https://b.test/2' }, { url: 'https://a.test/1' }, { url: 'javascript:alert(1)' }],
    };
    expect(parsePerplexity(data)).toEqual({ text: 'Answer [1]', citations: ['https://a.test/1', 'https://b.test/2'] });
  });

  it('builds OpenAI requests with optional reasoning and web search', () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'k', OPENAI_REASONING_EFFORT: '', OPENAI_WEB_SEARCH: 'true' });
    const req = openaiRequest(cfg.engines.openai!, 'q', cfg);
    const body = req.body as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.max_output_tokens).toBe(900);
  });

  it('redacts key-like strings from provider errors', () => {
    expect(providerErrorMessage(401, { error: { message: 'Invalid key sk-abcdefghijklmnop' } })).toBe(
      'HTTP 401: Invalid key [redacted]',
    );
  });
});

describe('Gemini', () => {
  it('reads GEMINI_* settings, strips a models/ prefix and defaults to no grounding', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'g', GEMINI_MODEL: 'models/gemini-x' });
    expect(cfg.engines.gemini!.model).toBe('gemini-x');
    expect(cfg.geminiGrounding).toBe(false);
    expect(cfg.geminiThinkingLevel).toBe('low');
    expect(loadConfig({ GEMINI_API_KEY: 'g' }).engines.gemini!.model).toBe(DEFAULT_MODELS.gemini);
  });

  it('builds a generateContent request with thinking headroom and optional grounding', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'gk', GEMINI_GROUNDING: 'true' });
    const req = geminiRequest(cfg.engines.gemini!, 'best agency?', cfg);
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('gk');
    expect(req.url).not.toContain('gk');
    expect(req.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'best agency?' }] }],
      generationConfig: { maxOutputTokens: 2400, thinkingConfig: { thinkingLevel: 'low' } },
      tools: [{ google_search: {} }],
    });
    const plain = loadConfig({ GEMINI_API_KEY: 'gk', GEMINI_THINKING_LEVEL: '' });
    const body = geminiRequest(plain.engines.gemini!, 'q', plain).body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({ maxOutputTokens: 900 });
  });

  it('parses text parts, skips thoughts and turns grounding chunks into source domains', () => {
    const data = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'thinking...', thought: true }, { text: '1. **NULA** – web from €190.' }, { text: '\n2. Other' }],
          },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['web design agency Skopje'],
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC', title: 'agencynula.com' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DeF', title: 'Clutch.co' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/GhI', title: 'Not a domain' } },
              { web: { uri: 'https://www.goodfirms.co/list', title: 'GoodFirms' } },
              { retrievedContext: { uri: 'x' } },
            ],
          },
        },
      ],
    };
    expect(parseGemini(data)).toEqual({
      text: '1. **NULA** – web from €190.\n2. Other',
      citations: ['https://agencynula.com/', 'https://clutch.co/', 'https://www.goodfirms.co/list'],
    });
  });

  it('explains empty answers', () => {
    expect(parseGemini({ promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ text: '', note: 'Blocked by Gemini (SAFETY)' });
    expect(parseGemini({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }).note).toContain('token limit');
    expect(parseGemini({ candidates: [{ finishReason: 'RECITATION' }] }).note).toBe('Stopped by Gemini (RECITATION)');
    expect(parseGemini(null)).toEqual({ text: '', citations: [] });
  });

  it('keeps direct links and drops unusable redirects', () => {
    expect(geminiCitation('https://example.mk/page', 'example.mk')).toBe('https://example.mk/page');
    expect(geminiCitation('', 'example.mk')).toBe('https://example.mk/');
    expect(geminiCitation('https://vertexaisearch.cloud.google.com/x', '')).toBe('');
  });

  it('redacts Google API keys from errors and reports block reasons as failures', async () => {
    expect(providerErrorMessage(400, { error: { code: 400, message: 'API key not valid: AIzaSyA1234567890abcdefghijklmnop', status: 'INVALID_ARGUMENT' } })).toBe(
      'HTTP 400: API key not valid: [redacted]',
    );
    const cfg = loadConfig({ GEMINI_API_KEY: 'gk' });
    const a = await callEngine(cfg.engines.gemini!, 'q', cfg, async () => Response.json({ promptFeedback: { blockReason: 'OTHER' } }));
    expect(a).toMatchObject({ engine: 'gemini', ok: false, error: 'Blocked by Gemini (OTHER)' });
  });
});

describe('callEngine', () => {
  const cfg = loadConfig({ PERPLEXITY_API_KEY: 'pk', ENGINE_TIMEOUT_MS: '2000' });
  const engine = cfg.engines.perplexity!;

  it('returns an ok answer', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer pk');
      return Response.json({ choices: [{ message: { content: 'Example Studio' } }], citations: [] });
    };
    const a = await callEngine(engine, 'q', cfg, fetchImpl);
    expect(a).toMatchObject({ engine: 'perplexity', ok: true, text: 'Example Studio' });
  });

  it('turns HTTP errors into failed answers', async () => {
    const a = await callEngine(engine, 'q', cfg, async () => Response.json({ error: 'rate limited' }, { status: 429 }));
    expect(a).toMatchObject({ ok: false, error: 'HTTP 429: rate limited' });
  });

  it('turns timeouts into failed answers', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const a = await callEngine(engine, 'q', cfg, async () => {
      throw timeout;
    });
    expect(a).toMatchObject({ ok: false, error: 'Timed out after 2s' });
  });

  it('treats an empty answer as a failure', async () => {
    const a = await callEngine(engine, 'q', cfg, async () => Response.json({ choices: [] }));
    expect(a).toMatchObject({ ok: false, error: 'Empty answer' });
  });
});
