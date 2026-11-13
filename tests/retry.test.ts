import { describe, expect, it, vi } from 'vitest';
import { callEngine, type FetchLike } from '../server/providers.ts';
import { loadConfig } from '../server/config.ts';
import { computeScore } from '../src/lib/scoring.ts';

const geminiOk = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
const busy = () => Response.json({ error: { message: 'This model is currently experiencing high demand.' } }, { status: 503 });
const noSleep = async () => {};

describe('callEngine retries and Gemini fallback', () => {
  const cfg = loadConfig({ GEMINI_API_KEY: 'AIza-test-key-0000000000000000', ENGINE_TIMEOUT_MS: '20000' });
  const engine = cfg.engines.gemini!;

  it('retries once on 503 and succeeds with the same model', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? busy() : geminiOk('1. Example Studio');
    });
    const a = await callEngine(engine, 'q', cfg, fetchImpl, noSleep);
    expect(a).toMatchObject({ ok: true, model: 'gemini-3.8-flash', text: '1. Example Studio' });
    expect(calls).toHaveLength(2);
  });

  it('falls back to the older model when the main one stays busy', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      calls.push(url);
      return url.includes('gemini-3.7-flash') ? geminiOk('NULA') : busy();
    });
    const a = await callEngine(engine, 'q', cfg, fetchImpl, noSleep);
    expect(a).toMatchObject({ ok: true, model: 'gemini-3.7-flash', text: 'NULA' });
    expect(calls.map((u) => (u.includes('3.8') ? '3.8' : '3.7'))).toEqual(['3.8', '3.8', '3.7']);
  });

  it('keeps the original error when the fallback fails for another reason', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url: string) =>
      url.includes('gemini-3.7-flash') ? Response.json({ error: { message: 'model not found' } }, { status: 404 }) : busy(),
    );
    const a = await callEngine(engine, 'q', cfg, fetchImpl, noSleep);
    expect(a).toMatchObject({ ok: false, model: 'gemini-3.8-flash', error: expect.stringMatching(/^HTTP 503: .*high demand/) });
  });

  it('does not retry client errors like 400', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => Response.json({ error: { message: 'bad request' } }, { status: 400 }));
    await callEngine(engine, 'q', cfg, fetchImpl, noSleep);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('can disable the fallback with an empty GEMINI_FALLBACK_MODEL', async () => {
    const noFallback = loadConfig({
      GEMINI_API_KEY: 'AIza-test-key-0000000000000000',
      ENGINE_TIMEOUT_MS: '20000',
      GEMINI_FALLBACK_MODEL: '',
    });
    const fetchImpl: FetchLike = vi.fn(async () => busy());
    await callEngine(noFallback.engines.gemini!, 'q', noFallback, fetchImpl, noSleep);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('only uses the fallback for Gemini', async () => {
    const c = loadConfig({ PERPLEXITY_API_KEY: 'pk', ENGINE_TIMEOUT_MS: '20000' });
    const fetchImpl: FetchLike = vi.fn(async () => busy());
    await callEngine(c.engines.perplexity!, 'q', c, fetchImpl, noSleep);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('score when nothing answered', () => {
  it("reports 'no-data' instead of a real-looking 0", () => {
    const failed = { engine: 'gemini', ok: false, mentioned: false, position: null, listLength: null } as never;
    const s = computeScore([failed, failed]);
    expect(s.band).toBe('no-data');
    expect(s.answered).toBe(0);
  });
});
