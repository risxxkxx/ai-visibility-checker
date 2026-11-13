import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@netlify/functions';
import { createPublicCheckHandler } from '../netlify/functions/public-check.ts';
import { createPublicLeadHandler } from '../netlify/functions/public-lead.ts';
import { GuardError, type SafeFetchResult } from '../server/audit/ssrf.mjs';
import type { FetchPage } from '../server/siteAudit.ts';
import { allowedHostnames, parseAllowedOrigins } from '../server/public/config.ts';
import { supabaseHeaders } from '../server/public/supabase.ts';
import { CONSENT_TEXT, consentRecord } from '../server/public/consent.ts';
import { namedBusinesses, type PublicFullReport } from '../src/lib/publicReport.ts';
import type { EngineAnswer } from '../src/lib/types.ts';

const html = readFileSync(new URL('./fixtures/geo-site.html', import.meta.url), 'utf8');

const ORIGIN = 'https://agencynula.com';
const SECRET = 'turnstile-secret-0000-test';
const SB_KEY = 'sb_secret_TESTKEY_abcdefghijklmnop';
const GEMINI_KEY = 'AIza-test-gemini-key-000000000000';
const SALT = 'salt-for-tests-1234567890';
const IP = '203.0.113.7';
const NOW = () => new Date('2026-11-13T10:00:00Z');

const ENV = {
  TURNSTILE_SECRET_KEY: SECRET,
  SUPABASE_URL: 'https://fbxpnxxasszincqghozo.supabase.co',
  SUPABASE_SECRET_KEY: SB_KEY,
  IP_HASH_SALT: SALT,
  GEMINI_API_KEY: GEMINI_KEY,
  GEMINI_FALLBACK_MODEL: '',
};

const ctx = (ip = IP) => ({ ip }) as unknown as Context;

const GOOD_ANSWER = [
  'Here are good options in Skopje:',
  '',
  '1. **Vulkan Plus** – fast service, fair prices.',
  '2. **Primer Studio** – modern websites, from €190.',
  '3. **Guma Express** – open on Sundays.',
  '',
  'Tips: compare prices first.',
].join('\n');

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
type SummaryJson = { status: string; visibility: { score: number | null; band: string }; readiness: { score: number | null }; mentions: unknown; topFixes: unknown[] };

interface Backend {
  fetch: ReturnType<typeof vi.fn<FetchFn>>;
  counters: Map<string, number>;
  checks: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  calls: { url: string; init: RequestInit }[];
  gemini: () => number;
  turnstile: () => number;
}

interface BackendOptions {
  turnstile?: Record<string, unknown> | (() => Response);
  gemini?: () => Response;
  rpcStatus?: number;
  seedChecks?: Record<string, unknown>[];
}

/** One fetch mock for Turnstile, Supabase PostgREST and Gemini, with in-memory tables. */
function backend(opts: BackendOptions = {}): Backend {
  const counters = new Map<string, number>();
  const checks: Record<string, unknown>[] = [...(opts.seedChecks ?? [])];
  const leads: Record<string, unknown>[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let ids = 0;
  const fetch = vi.fn<FetchFn>(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.hostname === 'challenges.cloudflare.com') {
      if (typeof opts.turnstile === 'function') return opts.turnstile();
      return Response.json(opts.turnstile ?? { success: true, hostname: 'agencynula.com', action: 'ai-check', 'error-codes': [], challenge_ts: '2026-11-13T09:59:00Z' });
    }
    if (u.hostname === 'generativelanguage.googleapis.com') {
      if (opts.gemini) return opts.gemini();
      return Response.json({ candidates: [{ content: { parts: [{ text: GOOD_ANSWER }] }, finishReason: 'STOP' }] });
    }
    if (u.hostname.endsWith('.supabase.co')) {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (u.pathname === '/rest/v1/rpc/try_increment_usage') {
        if (opts.rpcStatus) return new Response('{"message":"down"}', { status: opts.rpcStatus });
        const key = String(body!.p_key);
        const used = counters.get(key) ?? 0;
        if (used >= Number(body!.p_limit)) return Response.json(false);
        counters.set(key, used + 1);
        return Response.json(true);
      }
      if (u.pathname === '/rest/v1/public_checks' && init.method === 'GET') {
        const p = u.searchParams;
        const eq = (k: string) => p.get(k)?.replace(/^eq\./, '');
        let rows = checks;
        if (p.get('id')) rows = rows.filter((r) => r.id === eq('id'));
        if (p.get('domain')) rows = rows.filter((r) => r.domain === eq('domain') && r.lang === eq('lang') && Number(r.answered) > 0 && String(r.created_at) >= p.get('created_at')!.slice(4));
        return Response.json(rows.slice(0, 1));
      }
      if (u.pathname === '/rest/v1/public_checks' && init.method === 'POST') {
        const row = { ...body, id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, created_at: NOW().toISOString() };
        checks.push(row);
        return Response.json([{ id: row.id }], { status: 201 });
      }
      if (u.pathname === '/rest/v1/leads' && init.method === 'POST') {
        const dup = leads.some((l) => l.check_id === body!.check_id && String(l.email).toLowerCase() === String(body!.email).toLowerCase());
        if (dup) return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint' }, { status: 409 });
        leads.push(body!);
        return Response.json([{ id: `lead-${leads.length}` }], { status: 201 });
      }
    }
    return new Response('not found', { status: 404 });
  });
  return {
    fetch,
    counters,
    checks,
    leads,
    calls,
    gemini: () => calls.filter((c) => c.url.includes('generativelanguage')).length,
    turnstile: () => calls.filter((c) => c.url.includes('challenges.cloudflare.com')).length,
  };
}

/** Fake SSRF-guarded fetch: primer.example and its side files. Unknown URLs fail like unreachable hosts. */
const fetchPage: FetchPage = vi.fn(async (url: string): Promise<SafeFetchResult> => {
  const base = { status: 200, finalUrl: url, redirects: [url], contentType: 'text/html', body: null, bytes: 0, truncated: false };
  if (url === 'https://primer.example/') return { ...base, body: html, bytes: html.length };
  if (url === 'https://primer.example/robots.txt') return { ...base, contentType: 'text/plain', body: 'User-agent: *\nAllow: /' };
  if (url === 'https://primer.example/llms.txt') return { ...base, status: 404, body: 'nope' };
  throw new GuardError('network', 'x');
});

function checkHandler(b: Backend, env: Record<string, string | undefined> = {}) {
  return createPublicCheckHandler({ env: () => ({ ...ENV, ...env }), now: NOW, fetchImpl: b.fetch, fetchPage });
}

function leadHandler(b: Backend, env: Record<string, string | undefined> = {}) {
  return createPublicLeadHandler({ env: () => ({ ...ENV, ...env }), now: NOW, fetchImpl: b.fetch });
}

const checkBody = (over: Record<string, unknown> = {}) => ({
  name: 'Primer Studio',
  domain: 'https://www.primer.example/contact',
  category: 'web design agency',
  city: 'Skopje',
  lang: 'en',
  turnstileToken: 'tok-123',
  ...over,
});

const post = (path: string, body: unknown, origin: string | null = ORIGIN) =>
  new Request(`https://checker.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const preflightReq = (path: string, origin: string) =>
  new Request(`https://checker.test${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });

const SECRETS = [SECRET, SB_KEY, GEMINI_KEY, SALT, IP];
async function textOf(res: Response): Promise<string> {
  const text = await res.text();
  for (const s of SECRETS) expect(text).not.toContain(s);
  return text;
}

describe('public endpoints: CORS', () => {
  it('answers preflight for allowed origins and refuses others', async () => {
    const b = backend();
    for (const handler of [checkHandler(b), leadHandler(b)]) {
      const ok = await handler(preflightReq('/api/public/check', 'https://www.agencynula.com'), ctx());
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://www.agencynula.com');
      expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
      expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
      expect(ok.headers.get('vary')).toBe('Origin');
      const bad = await handler(preflightReq('/api/public/check', 'https://evil.test'), ctx());
      expect(bad.status).toBe(403);
      expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('rejects POSTs from other origins or without an Origin before doing any work', async () => {
    const b = backend();
    const handler = checkHandler(b);
    expect((await handler(post('/api/public/check', checkBody(), 'https://evil.test'), ctx())).status).toBe(403);
    expect((await handler(post('/api/public/check', checkBody(), null), ctx())).status).toBe(403);
    expect((await leadHandler(b)(post('/api/public/lead', {}, 'https://agencynula.com.evil.test'), ctx())).status).toBe(403);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('reflects the allowed origin and reads PUBLIC_ALLOWED_ORIGINS', async () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['https://agencynula.com', 'https://www.agencynula.com']);
    expect(parseAllowedOrigins(' https://a.example/ , nope, http://localhost:8888')).toEqual(['https://a.example', 'http://localhost:8888']);
    expect(allowedHostnames(['https://a.example', 'http://localhost:8888'])).toEqual(['a.example', 'localhost']);
    const b = backend();
    const res = await checkHandler(b, { PUBLIC_ALLOWED_ORIGINS: 'https://staging.example' })(post('/api/public/check', checkBody(), 'https://staging.example'), ctx());
    // Allowed by CORS, but Turnstile reported agencynula.com, which is not in this allow-list.
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://staging.example');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(((await res.json()) as { code: string }).code).toBe('turnstile_failed');
  });
});

describe('POST /api/public/check', () => {
  it('fails closed (503) when the Turnstile secret, Supabase, salt or Gemini key is missing', async () => {
    for (const missing of ['TURNSTILE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'IP_HASH_SALT', 'GEMINI_API_KEY']) {
      const b = backend();
      const res = await checkHandler(b, { [missing]: '' })(post('/api/public/check', checkBody()), ctx());
      expect(res.status, missing).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('not_configured');
      expect(b.fetch).not.toHaveBeenCalled();
    }
    const b = backend();
    expect((await checkHandler(b, { IP_HASH_SALT: 'short' })(post('/api/public/check', checkBody()), ctx())).status).toBe(503);
  });

  it('validates input before calling anything', async () => {
    const b = backend();
    const handler = checkHandler(b);
    const bad = [
      checkBody({ name: '' }),
      checkBody({ domain: 'not a domain' }),
      checkBody({ domain: '127.0.0.1' }),
      checkBody({ domain: 'printer.local' }),
      checkBody({ category: ' ' }),
      checkBody({ city: '' }),
      checkBody({ lang: 'de' }),
      checkBody({ turnstileToken: '' }),
      checkBody({ name: 'x'.repeat(81) }),
    ];
    for (const body of bad) expect((await handler(post('/api/public/check', body), ctx())).status, JSON.stringify(body)).toBe(400);
    expect((await handler(post('/api/public/check', '{nope'), ctx())).status).toBe(400);
    expect((await handler(post('/api/public/check', checkBody({ turnstileToken: 'x'.repeat(5000) })), ctx())).status).toBe(413);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('verifies Turnstile with secret, token, IP and an idempotency key', async () => {
    const b = backend();
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    const call = b.calls.find((c) => c.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify')!;
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(call.init.body));
    expect(form.get('secret')).toBe(SECRET);
    expect(form.get('response')).toBe('tok-123');
    expect(form.get('remoteip')).toBe(IP);
    expect(form.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['token rejected', { success: false, 'error-codes': ['invalid-input-response'] }, 403, 'turnstile_failed'],
    ['token reused', { success: false, 'error-codes': ['timeout-or-duplicate'] }, 403, 'turnstile_failed'],
    ['wrong hostname', { success: true, hostname: 'evil.test', action: 'ai-check' }, 403, 'turnstile_failed'],
    ['wrong action', { success: true, hostname: 'agencynula.com', action: 'login' }, 403, 'turnstile_failed'],
    ['Cloudflare error', { success: false, 'error-codes': ['internal-error'] }, 503, 'turnstile_unavailable'],
  ])('refuses the check when Turnstile fails: %s', async (_name, turnstile, status, code) => {
    const b = backend({ turnstile });
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
    expect(b.counters.size).toBe(0);
    expect(b.gemini()).toBe(0);
  });

  it('treats an unreachable siteverify as unavailable (503)', async () => {
    const b = backend({ turnstile: () => new Response('bad gateway', { status: 502 }) });
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(503);
    expect(b.gemini()).toBe(0);
  });

  it('runs 5 Gemini prompts plus the website audit and returns only the summary', async () => {
    const b = backend();
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const text = await textOf(res);
    const summary = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(
      ['business', 'cached', 'checkId', 'checkedAt', 'competitors', 'lang', 'mentions', 'readiness', 'status', 'topFixes', 'visibility'].sort(),
    );
    expect(summary).toMatchObject({
      status: 'ok',
      cached: false,
      lang: 'en',
      business: { name: 'Primer Studio', domain: 'primer.example', category: 'web design agency', city: 'Skopje' },
      mentions: { count: 5, answered: 5, total: 5 },
      competitors: [
        { name: 'Vulkan Plus', mentions: 5 },
        { name: 'Guma Express', mentions: 5 },
      ],
    });
    expect((summary.visibility as { score: number }).score).toBeGreaterThan(0);
    expect((summary.visibility as { bandText: string }).bandText).toMatch(/\w/);
    expect((summary.readiness as { score: number }).score).toBeGreaterThan(0);
    const fixes = summary.topFixes as { title: string; why: string }[];
    expect(fixes).toHaveLength(3);
    for (const f of fixes) expect(Object.keys(f).sort()).toEqual(['title', 'why']);
    // Nothing from the full report leaks: no answers, steps, prompts or drafts.
    expect(text).not.toContain('fast service, fair prices');
    expect(text).not.toContain('application/ld+json');
    expect(text).not.toMatch(/"steps"|"answers"|"prompts"|"report"|"analyses"/);

    expect(b.gemini()).toBe(5);
    expect(b.checks).toHaveLength(1);
    const row = b.checks[0]!;
    expect(summary.checkId).toBe(row.id);
    expect(row).toMatchObject({ domain: 'primer.example', business_name: 'Primer Studio', lang: 'en', answered: 5, ip_hash: createHash('sha256').update(IP + SALT).digest('hex') });
    expect((row.report as { answers: unknown[] }).answers).toHaveLength(5);
    // The raw IP never goes to the database.
    for (const c of b.calls.filter((x) => x.url.includes('supabase.co'))) {
      expect(`${c.url} ${String(c.init.body ?? '')}`).not.toContain(IP);
      expect((c.init.headers as Record<string, string>).apikey).toBe(SB_KEY);
      expect((c.init.headers as Record<string, string>).authorization).toBeUndefined();
    }
    expect(b.counters.get('pub:checks:2026-11')).toBe(1);
    expect(b.counters.get('engine:gemini:2026-11')).toBe(5);
  });

  it('writes Macedonian prompts and text when lang is mk', async () => {
    const b = backend();
    const res = await checkHandler(b)(post('/api/public/check', checkBody({ lang: 'mk', category: 'вулканизер', city: 'Скопје' })), ctx());
    const summary = (await res.json()) as { visibility: { bandText: string }; topFixes: { title: string }[] };
    expect(summary.visibility.bandText).toMatch(/[а-ш]/);
    expect(summary.topFixes[0]!.title).toMatch(/[а-ш]/);
    const prompt = JSON.parse(String(b.calls.find((c) => c.url.includes('generativelanguage'))!.init.body)).contents[0].parts[0].text as string;
    expect(prompt).toContain('вулканизер');
    expect(prompt).toContain('Скопје');
  });

  it('allows 3 checks per IP per day', async () => {
    const b = backend();
    const handler = checkHandler(b);
    const statuses: number[] = [];
    for (const d of ['a', 'b', 'c', 'd']) statuses.push((await handler(post('/api/public/check', checkBody({ domain: `${d}.example` })), ctx())).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await handler(post('/api/public/check', checkBody({ domain: 'e.example' })), ctx('198.51.100.1'))).status).toBe(200);
  });

  it('stops at the monthly public cap and at the Gemini cap', async () => {
    let b = backend();
    let handler = checkHandler(b, { PUBLIC_MONTHLY_CHECKS: '1' });
    expect((await handler(post('/api/public/check', checkBody({ domain: 'a.example' })), ctx('198.51.100.1'))).status).toBe(200);
    const res = await handler(post('/api/public/check', checkBody({ domain: 'b.example' })), ctx('198.51.100.2'));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('monthly_limit');

    b = backend();
    handler = checkHandler(b, { MONTHLY_LIMIT_GEMINI: '3' });
    const first = (await (await handler(post('/api/public/check', checkBody()), ctx())).json()) as { mentions: { total: number } };
    expect(first.mentions.total).toBe(3);
    expect(b.gemini()).toBe(3);
    const second = await handler(post('/api/public/check', checkBody({ domain: 'b.example' })), ctx());
    expect(second.status).toBe(429);
    expect(b.gemini()).toBe(3);
  });

  it('fails closed (503) when the usage counter is down', async () => {
    const b = backend({ rpcStatus: 500 });
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('counter_unavailable');
    expect(b.gemini()).toBe(0);
  });

  it('answers from the 7-day cache without engine calls or monthly counters', async () => {
    const summary = { status: 'ok', lang: 'en', visibility: { score: 61 }, checkId: null, cached: false };
    const seed = (ipHash: string, createdAt = '2026-11-10T08:00:00.000Z') => ({
      id: '11111111-1111-4111-8111-111111111111',
      created_at: createdAt,
      domain: 'primer.example',
      lang: 'en',
      answered: 5,
      ip_hash: ipHash,
      summary,
    });
    const myHash = createHash('sha256').update(IP + SALT).digest('hex');

    // Same visitor: free.
    let b = backend({ seedChecks: [seed(myHash)] });
    let res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkId: '11111111-1111-4111-8111-111111111111', cached: true, visibility: { score: 61 } });
    expect(b.gemini()).toBe(0);
    expect(b.counters.size).toBe(0);

    // Another visitor: one of their daily checks, still no engine calls.
    b = backend({ seedChecks: [seed('someone-else')] });
    res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    expect(b.gemini()).toBe(0);
    expect([...b.counters.keys()]).toEqual([`pub:ip:${myHash}:2026-11-13`]);

    // Older than 7 days, other language, or a run where nothing answered: runs again.
    b = backend({ seedChecks: [seed(myHash, '2026-11-01T08:00:00.000Z'), { ...seed(myHash), lang: 'mk' }, { ...seed(myHash), answered: 0 }] });
    res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(((await res.json()) as { cached: boolean }).cached).toBe(false);
    expect(b.gemini()).toBe(5);
  });

  it('shows "AI did not answer" with the website result when every Gemini call fails, without a fake 0', async () => {
    const b = backend({ gemini: () => Response.json({ error: { message: 'The model is overloaded.' } }, { status: 503 }) });
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    const summary = (await res.json()) as SummaryJson;
    expect(summary.status).toBe('no-answer');
    expect(summary.visibility.score).toBeNull();
    expect(summary.visibility.band).toBe('no-data');
    expect(summary.mentions).toEqual({ count: 0, answered: 0, total: 5 });
    expect(summary.readiness.score).toBeGreaterThan(0);
    expect(summary.topFixes.length).toBeGreaterThan(0);
    expect(b.checks[0]).toMatchObject({ visibility_score: null, answered: 0 });
  }, 15_000);

  it('still returns the AI result when the website cannot be audited', async () => {
    const b = backend();
    const res = await checkHandler(b)(post('/api/public/check', checkBody({ domain: 'down.example' })), ctx());
    const summary = (await res.json()) as SummaryJson;
    expect(summary.status).toBe('ok');
    expect(summary.readiness.score).toBeNull();
    expect(summary.visibility.score).toBeGreaterThanOrEqual(0);
  });

  it('returns the summary without a checkId when saving fails', async () => {
    const b = backend();
    const inner = b.fetch.getMockImplementation()!;
    b.fetch.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith('/public_checks?select=id') ? new Response('{"message":"boom"}', { status: 500 }) : inner(url, init),
    );
    const res = await checkHandler(b)(post('/api/public/check', checkBody()), ctx());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checkId: unknown }).checkId).toBeNull();
  });
});

describe('POST /api/public/lead', () => {
  async function withCheck() {
    const b = backend();
    const summary = (await (await checkHandler(b)(post('/api/public/check', checkBody()), ctx())).json()) as { checkId: string };
    return { b, checkId: summary.checkId };
  }
  const leadBody = (checkId: string, over: Record<string, unknown> = {}) => ({ checkId, email: 'owner@primer.example', name: 'Ana', phone: '070 123 456', consent: true, ...over });

  it('validates the e-mail, phone and consent', async () => {
    const { b, checkId } = await withCheck();
    const handler = leadHandler(b);
    for (const email of ['', 'nope', 'a@b', 'a b@c.mk', `${'x'.repeat(250)}@a.mk`]) {
      const res = await handler(post('/api/public/lead', leadBody(checkId, { email })), ctx());
      expect(res.status, email).toBe(400);
    }
    let res = await handler(post('/api/public/lead', leadBody(checkId, { consent: false })), ctx());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('consent_required');
    res = await handler(post('/api/public/lead', leadBody(checkId, { consent: 'yes' })), ctx());
    expect(res.status).toBe(400);
    expect((await handler(post('/api/public/lead', leadBody(checkId, { phone: 'call me' })), ctx())).status).toBe(400);
    expect((await handler(post('/api/public/lead', leadBody('not-a-uuid')), ctx())).status).toBe(400);
    expect((await handler(post('/api/public/lead', leadBody('22222222-2222-4222-8222-222222222222')), ctx())).status).toBe(404);
    expect(b.leads).toHaveLength(0);
  });

  it('stores the lead with the exact consent text and returns the full report', async () => {
    const { b, checkId } = await withCheck();
    const res = await leadHandler(b)(post('/api/public/lead', leadBody(checkId, { lang: 'mk' })), ctx());
    expect(res.status).toBe(200);
    const data = JSON.parse(await textOf(res)) as { ok: boolean; duplicate: boolean; report: PublicFullReport };
    expect(data).toMatchObject({ ok: true, duplicate: false });
    expect(b.leads[0]).toEqual({
      check_id: checkId,
      email: 'owner@primer.example',
      name: 'Ana',
      phone: '070 123 456',
      consent: true,
      consent_text: consentRecord('mk'),
    });
    expect(String(b.leads[0]!.consent_text)).toContain(CONSENT_TEXT.mk);

    const r = data.report;
    expect(r.checkId).toBe(checkId);
    expect(r.lang).toBe('en'); // the language the check ran in
    expect(r.prompts).toHaveLength(5);
    expect(r.prompts[0]).toEqual({ prompt: expect.any(String), answered: true, mentioned: true, position: 2, competitors: ['Vulkan Plus', 'Guma Express'] });
    expect(r.recommendations.length).toBeGreaterThan(3);
    for (const rec of r.recommendations) {
      expect(Object.keys(rec).sort()).toEqual(['id', 'priority', 'priorityText', 'status', 'steps', 'title', 'why']);
    }
    expect(r.recommendations.some((rec) => rec.steps.length > 0)).toBe(true);
    expect(r.readinessChecks.length).toBeGreaterThan(5);
    expect(r.readinessChecks[0]).toMatchObject({ id: 'schema', state: 'pass', stateText: 'OK' });
    expect(r.drafts.schema).toContain('application/ld+json');
    expect(r.drafts.llmsTxt).toContain('# Primer Studio');
    expect(r).not.toHaveProperty('answers');
  });

  it('treats the same e-mail for the same check as success', async () => {
    const { b, checkId } = await withCheck();
    const handler = leadHandler(b);
    expect((await handler(post('/api/public/lead', leadBody(checkId)), ctx())).status).toBe(200);
    const again = await handler(post('/api/public/lead', leadBody(checkId, { email: 'OWNER@primer.example' })), ctx());
    expect(again.status).toBe(200);
    const data = (await again.json()) as { duplicate: boolean; report: { prompts: unknown[] } };
    expect(data.duplicate).toBe(true);
    expect(data.report.prompts).toHaveLength(5);
    expect(b.leads).toHaveLength(1);
  });

  it('allows 10 leads per IP per day and fails closed without storage', async () => {
    const { b, checkId } = await withCheck();
    const handler = leadHandler(b);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await handler(post('/api/public/lead', leadBody(checkId, { email: `o${i}@primer.example` })), ctx())).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    expect((await leadHandler(b, { SUPABASE_SECRET_KEY: '' })(post('/api/public/lead', leadBody(checkId)), ctx())).status).toBe(503);
    expect((await leadHandler(backend({ rpcStatus: 500 }))(post('/api/public/lead', leadBody(checkId)), ctx())).status).toBe(503);
  });
});

describe('public helpers', () => {
  it('sends Authorization only for legacy JWT keys', () => {
    expect(supabaseHeaders('sb_secret_abc')).not.toHaveProperty('authorization');
    expect(supabaseHeaders('eyJhbGciOiJIUzI1NiJ9.x.y')).toMatchObject({ apikey: 'eyJhbGciOiJIUzI1NiJ9.x.y', authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' });
  });

  it('lists the businesses AI named, without the business itself or generic headings', () => {
    const answer = (text: string): EngineAnswer => ({ engine: 'gemini', model: 'm', prompt: 'p', ok: true, text, citations: [], latencyMs: 1 });
    const answers = [
      answer('1. **Vulkan Plus** – good\n2. **Пример Студио** – us\n3. [Guma Express](https://guma.example) – ok\n4. **Совети:** проверете ги цените'),
      answer('- Guma Express: open late\n- Tips: call first\n- what to ask?\n- Vulkan Plus: cheap'),
      answer('### 1. Auto Centar Ilinden\nDetails'),
      { ...answer('1. **Ignored**'), ok: false },
    ];
    expect(namedBusinesses(answers, { name: 'Primer Studio', aliases: ['Пример Студио'], domain: 'primer.example' })).toEqual([
      { name: 'Vulkan Plus', mentions: 2 },
      { name: 'Guma Express', mentions: 2 },
      { name: 'Auto Centar Ilinden', mentions: 1 },
    ]);
  });
});
