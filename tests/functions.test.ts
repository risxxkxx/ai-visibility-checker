import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context } from '@netlify/functions';

type Handler = (req: Request, context: Context) => Promise<Response>;
let ask: Handler;
let engines: () => Promise<Response>;

const ctx = (ip: string) => ({ ip }) as unknown as Context;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://app.test/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.OPENAI_API_KEY = 'sk-test-openai';
  process.env.PERPLEXITY_API_KEY = 'pplx-test';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.GEMINI_API_KEY = 'AIza-test-gemini-key-000000000000';
  process.env.RATE_LIMIT_REQUESTS = '3';
  ask = (await import('../netlify/functions/ask.ts')).default as Handler;
  engines = (await import('../netlify/functions/engines.ts')).default as () => Promise<Response>;
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/engines', () => {
  it('lists engines without leaking keys', async () => {
    const res = await engines();
    const text = await res.text();
    expect(text).not.toContain('sk-test-openai');
    expect(text).not.toContain('AIza-test-gemini');
    const data = JSON.parse(text) as { engines: { id: string; available: boolean }[] };
    expect(data.engines.map((e) => [e.id, e.available])).toEqual([
      ['anthropic', false],
      ['openai', true],
      ['perplexity', true],
      ['gemini', true],
    ]);
  });
});

describe('POST /api/ask', () => {
  it('fans out to engines and keeps going when one fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('openai')) {
          return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '1. Example Studio' }] }] });
        }
        return new Response('upstream down', { status: 503 });
      }),
    );
    const res = await ask(post({ prompt: 'best agency in Skopje', engines: ['openai', 'perplexity'], runId: 'run-aaaaaaaa' }), ctx('1.1.1.1'));
    expect(res.status).toBe(200);
    const { answers } = (await res.json()) as { answers: { engine: string; ok: boolean; error?: string }[] };
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ engine: 'openai', ok: true });
    expect(answers[1]).toMatchObject({ engine: 'perplexity', ok: false, error: 'HTTP 503: upstream down' });
  });

  it('asks Gemini with the key in a header, never in the URL', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).not.toContain('AIza');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test-gemini-key-000000000000');
      return Response.json({ candidates: [{ content: { parts: [{ text: '1. Example Studio' }] }, finishReason: 'STOP' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await ask(post({ prompt: 'best agency in Skopje', engines: ['gemini'], runId: 'run-gggggggg' }), ctx('5.5.5.5'));
    const { answers } = (await res.json()) as { answers: { engine: string; ok: boolean; text: string }[] };
    expect(answers).toEqual([expect.objectContaining({ engine: 'gemini', ok: true, text: '1. Example Studio' })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid bodies, wrong methods and cross-origin calls', async () => {
    expect((await ask(post('{nope'), ctx('2.2.2.2'))).status).toBe(400);
    expect((await ask(post({ prompt: 'x', engines: ['openai'], runId: 'run-aaaaaaaa' }), ctx('2.2.2.2'))).status).toBe(400);
    expect((await ask(new Request('https://app.test/api/ask'), ctx('2.2.2.2'))).status).toBe(405);
    const cross = post({ prompt: 'best agency', engines: ['openai'], runId: 'run-aaaaaaaa' }, { origin: 'https://evil.test' });
    expect((await ask(cross, ctx('2.2.2.2'))).status).toBe(403);
  });

  it('refuses engines that are not configured', async () => {
    const res = await ask(post({ prompt: 'best agency', engines: ['anthropic'], runId: 'run-bbbbbbbb' }), ctx('3.3.3.3'));
    expect(res.status).toBe(400);
  });

  it('rate-limits per IP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'ok' } }] })));
    const body = { prompt: 'best agency', engines: ['perplexity'], runId: 'run-cccccccc' };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await ask(post(body), ctx('4.4.4.4'))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
