import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@netlify/functions';
import { checkAccess } from '../server/access.ts';
import { memoryCounterStore, monthKey, monthlyLimit, reserve, type CounterStore } from '../server/budget.ts';
import { createAskHandler } from '../netlify/functions/ask.ts';
import { createAuditHandler } from '../netlify/functions/audit.ts';
import { runCheck } from '../src/lib/client.ts';
import { RateLimiter } from '../server/guard.ts';

const CODE = 'correct-horse-battery';
const ctx = (ip: string) => ({ ip }) as unknown as Context;
const req = (url: string, body: unknown, code?: string) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code === undefined ? {} : { 'x-access-code': code }) },
    body: JSON.stringify(body),
  });
const askBody = (engines: string[], runId = 'run-aaaaaaaa') => ({ prompt: 'best web agency in Skopje', engines, runId });
const okGemini = () =>
  vi.fn(async (url: string) => {
    if (String(url).includes('generativelanguage')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: '1. Example Studio' }] } }] });
    }
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '1. Example Studio' }] }] });
  });

afterEach(() => vi.unstubAllGlobals());

describe('checkAccess', () => {
  const r = (code?: string) => req('https://app.test/api/ask', {}, code);

  it('fails closed when no ACCESS_CODE is configured', () => {
    expect(checkAccess(r(CODE), {})).toMatchObject({ ok: false, status: 503, code: 'access_not_configured' });
  });

  it('treats a too-short ACCESS_CODE as not configured', () => {
    expect(checkAccess(r('short'), { ACCESS_CODE: 'short' })).toMatchObject({ ok: false, status: 503 });
  });

  it('requires the header, rejects wrong codes, accepts the right one', () => {
    const env = { ACCESS_CODE: CODE };
    expect(checkAccess(r(), env)).toMatchObject({ ok: false, status: 401, code: 'access_required' });
    expect(checkAccess(r('wrong-code-123'), env)).toMatchObject({ ok: false, status: 401, code: 'access_denied' });
    expect(checkAccess(r(` ${CODE} `), env)).toEqual({ ok: true });
  });
});

describe('monthly budget', () => {
  it('blocks an engine once it reaches its cap and resets next month', async () => {
    const store = memoryCounterStore();
    const nov = new Date('2026-11-30T23:00:00Z');
    const limit = () => 2;
    expect((await reserve(store, ['gemini'], limit, nov)).allowed).toEqual(['gemini']);
    expect((await reserve(store, ['gemini'], limit, nov)).allowed).toEqual(['gemini']);
    expect(await reserve(store, ['gemini'], limit, nov)).toEqual({ allowed: [], blocked: ['gemini'] });
    expect((await reserve(store, ['gemini'], limit, new Date('2026-12-01T00:30:00Z'))).allowed).toEqual(['gemini']);
    expect(store.dump()).toEqual({ '2026-11:gemini': 2, '2026-12:gemini': 1 });
    expect(monthKey(nov)).toBe('2026-11');
  });

  it('reads per-engine limits from env with safe defaults', () => {
    expect(monthlyLimit('gemini', {})).toBe(4_500);
    expect(monthlyLimit('openai', {})).toBe(1_000);
    expect(monthlyLimit('gemini', { MONTHLY_LIMIT_GEMINI: '200' })).toBe(200);
    expect(monthlyLimit('gemini', { MONTHLY_LIMIT_GEMINI: '0' })).toBe(0);
    expect(monthlyLimit('gemini', { MONTHLY_LIMIT_GEMINI: 'lots' })).toBe(4_500);
    expect(monthlyLimit('gemini', { MONTHLY_LIMIT_GEMINI: '-5' })).toBe(4_500);
  });
});

describe('POST /api/ask with access code and monthly cap', () => {
  const baseEnv = { GEMINI_API_KEY: 'AIza-test-gemini-key-000000000000', OPENAI_API_KEY: 'sk-test-openai', RATE_LIMIT_REQUESTS: '100' };

  it('refuses live calls when ACCESS_CODE is missing on the server, without calling any engine', async () => {
    const fetchMock = okGemini();
    vi.stubGlobal('fetch', fetchMock);
    const ask = createAskHandler({ env: () => baseEnv, store: memoryCounterStore() });
    const res = await ask(req('https://app.test/api/ask', askBody(['gemini']), CODE), ctx('1.0.0.1'));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects wrong codes and locks out after repeated guesses', async () => {
    const fetchMock = okGemini();
    vi.stubGlobal('fetch', fetchMock);
    const ask = createAskHandler({ env: () => ({ ...baseEnv, ACCESS_CODE: CODE }), store: memoryCounterStore() });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await ask(req('https://app.test/api/ask', askBody(['gemini']), `guess-${i}-xxxx`), ctx('1.0.0.2'))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops at the monthly cap and reports capped engines as failed answers', async () => {
    vi.stubGlobal('fetch', okGemini());
    const store = memoryCounterStore();
    const env = { ...baseEnv, ACCESS_CODE: CODE, MONTHLY_LIMIT_GEMINI: '1', MONTHLY_LIMIT_OPENAI: '5' };
    const ask = createAskHandler({ env: () => env, store, now: () => new Date('2026-11-13T10:00:00Z') });

    const first = await ask(req('https://app.test/api/ask', askBody(['gemini', 'openai']), CODE), ctx('1.0.0.3'));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { answers: { ok: boolean }[] }).answers.every((a) => a.ok)).toBe(true);

    const second = await ask(req('https://app.test/api/ask', askBody(['gemini', 'openai'], 'run-bbbbbbbb'), CODE), ctx('1.0.0.3'));
    const { answers } = (await second.json()) as { answers: { engine: string; ok: boolean; error?: string }[] };
    expect(answers.find((a) => a.engine === 'openai')).toMatchObject({ ok: true });
    expect(answers.find((a) => a.engine === 'gemini')).toMatchObject({ ok: false, error: expect.stringMatching(/Monthly limit/) });

    const third = await ask(req('https://app.test/api/ask', askBody(['gemini'], 'run-cccccccc'), CODE), ctx('1.0.0.3'));
    expect(third.status).toBe(429);
    expect(((await third.json()) as { code: string }).code).toBe('monthly_limit');
    expect(store.dump()).toEqual({ '2026-11:gemini': 1, '2026-11:openai': 2 });
  });

  it('fails closed when the usage counter is unavailable', async () => {
    const fetchMock = okGemini();
    vi.stubGlobal('fetch', fetchMock);
    const broken: CounterStore = {
      get: async () => {
        throw new Error('blobs down');
      },
      set: async () => {},
    };
    const ask = createAskHandler({ env: () => ({ ...baseEnv, ACCESS_CODE: CODE }), store: broken });
    const res = await ask(req('https://app.test/api/ask', askBody(['gemini']), CODE), ctx('1.0.0.4'));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/audit with access code and monthly cap', () => {
  const page = vi.fn(async (url: string) => ({
    status: 200,
    finalUrl: url,
    redirects: [url],
    contentType: 'text/html',
    body: '<html lang="en"><head><title>Example</title></head><body><h1>Example</h1></body></html>',
    bytes: 90,
    truncated: false,
  }));

  it('needs the code before fetching anything', async () => {
    const handler = createAuditHandler({ fetchPage: page, psiRunner: vi.fn(), env: () => ({ ACCESS_CODE: CODE }), store: memoryCounterStore() });
    const res = await handler(req('https://app.test/api/audit', { domain: 'example.com' }, 'nope-nope-nope'), ctx('2.0.0.1'));
    expect(res.status).toBe(401);
    expect(page).not.toHaveBeenCalled();
  });

  it('enforces the monthly audit limit', async () => {
    const handler = createAuditHandler({
      fetchPage: page,
      psiRunner: vi.fn(),
      env: () => ({ ACCESS_CODE: CODE, MONTHLY_LIMIT_AUDIT: '1' }),
      store: memoryCounterStore(),
      limiter: new RateLimiter(100, 60_000),
    });
    expect((await handler(req('https://app.test/api/audit', { domain: 'example.com' }, CODE), ctx('2.0.0.2'))).status).toBe(200);
    const capped = await handler(req('https://app.test/api/audit', { domain: 'example.com' }, CODE), ctx('2.0.0.2'));
    expect(capped.status).toBe(429);
  });
});

describe('runCheck sends the access code', () => {
  it('adds the header and stops the run on 401 instead of repeating it for every prompt', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-access-code']).toBe('my-code-1234');
      return Response.json({ error: 'Wrong access code.' }, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onAnswers = vi.fn();
    await expect(
      runCheck({
        prompts: ['a', 'b', 'c', 'd', 'e'],
        engines: ['gemini'],
        concurrency: 1,
        signal: new AbortController().signal,
        onAnswers,
        accessCode: 'my-code-1234',
      }),
    ).rejects.toThrow('Wrong access code.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAnswers).not.toHaveBeenCalled();
  });
});
