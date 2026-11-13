import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAuditHandler, type FetchPage } from '../netlify/functions/audit.ts';
import { GuardError, type SafeFetchResult } from '../server/audit/ssrf.mjs';
import { parsePsiResponse } from '../server/audit/psi.mjs';
import { RateLimiter } from '../server/guard.ts';
import type { SiteAudit } from '../src/lib/types.ts';

const html = readFileSync(new URL('./fixtures/geo-site.html', import.meta.url), 'utf8');
const psiFixture = JSON.parse(readFileSync(new URL('./fixtures/psi-response.fixture.json', import.meta.url), 'utf8'));
const NOW = () => new Date('2026-11-13T10:00:00Z');

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://app.test/api/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

type Route = Partial<SafeFetchResult> | Error;

/** Fake SSRF-guarded fetch keyed by URL. Unknown URLs fail like an unreachable host. */
function pages(map: Record<string, Route>) {
  const calls: string[] = [];
  const fn: FetchPage = vi.fn(async (url: string) => {
    calls.push(url);
    const entry = map[url];
    if (!entry) throw new GuardError('network', 'Сајтот не може да се вчита.');
    if (entry instanceof Error) throw entry;
    return { status: 200, finalUrl: url, redirects: [url], contentType: 'text/html', body: null, bytes: 0, truncated: false, ...entry };
  });
  return Object.assign(fn, { calls });
}

const fresh = () => new RateLimiter(100, 60_000);

describe('POST /api/audit', () => {
  it('audits the home page plus llms.txt, robots.txt and the sitemap', async () => {
    const fetchPage = pages({
      'https://primer.example/': { body: html, bytes: html.length },
      'http://primer.example/': { finalUrl: 'https://primer.example/', redirects: ['http://primer.example/', 'https://primer.example/'] },
      'https://primer.example/llms.txt': { status: 404, contentType: 'text/html', body: '<html>404</html>' },
      'https://primer.example/robots.txt': {
        contentType: 'text/plain',
        body: 'User-agent: GPTBot\nDisallow: /\nSitemap: https://primer.example/sitemap_index.xml',
      },
      'https://primer.example/sitemap_index.xml': { contentType: 'application/xml', body: '<?xml version="1.0"?><sitemapindex/>' },
    });
    const psiRunner = vi.fn();
    const handler = createAuditHandler({ fetchPage, psiRunner, env: () => ({}), now: NOW, limiter: fresh() });
    const res = await handler(post({ domain: 'https://www.Primer.example/contact' }));
    expect(res.status).toBe(200);
    const { audit } = (await res.json()) as { audit: SiteAudit };
    expect(audit.domain).toBe('primer.example');
    expect(audit.httpRedirectsToHttps).toBe(true);
    expect(audit.llmsTxt.state).toBe('missing');
    expect(audit.robots.blockedAiBots).toEqual(['GPTBot']);
    expect(audit.sitemap).toBe('present');
    expect(audit.schema.present).toBe(true);
    expect(audit.psiStatus).toBe('not-configured');
    expect(psiRunner).not.toHaveBeenCalled();
    expect(fetchPage.calls).toContain('https://primer.example/sitemap_index.xml');
  });

  it('runs PageSpeed only when PAGESPEED_API_KEY is set, and survives PSI failures', async () => {
    const fetchPage = pages({ 'https://primer.example/': { body: html } });
    const psi = parsePsiResponse(psiFixture);
    const ok = vi.fn(async () => ({ psi: psi.ok ? psi.psi : null, reason: null }));
    let handler = createAuditHandler({ fetchPage, psiRunner: ok, env: () => ({ PAGESPEED_API_KEY: 'K' }), now: NOW, limiter: fresh() });
    let data = (await (await handler(post({ domain: 'primer.example' }))).json()) as { audit: SiteAudit };
    expect(ok).toHaveBeenCalledWith('https://primer.example/', { apiKey: 'K', timeoutMs: 20_000 });
    expect(data.audit.psiStatus).toBe('ok');
    expect(data.audit.psi).toMatchObject({ performance: 34, seo: 72, lcpMs: 7912.5 });
    // Side checks that failed are "unknown", not "missing".
    expect(data.audit.llmsTxt.state).toBe('unknown');
    expect(data.audit.robots.state).toBe('unknown');

    const boom = vi.fn(async () => {
      throw new Error('x');
    });
    handler = createAuditHandler({ fetchPage, psiRunner: boom, env: () => ({ PAGESPEED_API_KEY: 'K' }), now: NOW, limiter: fresh() });
    data = (await (await handler(post({ domain: 'primer.example' }))).json()) as { audit: SiteAudit };
    expect(data.audit.psiStatus).toBe('failed');

    const skipped = vi.fn();
    handler = createAuditHandler({ fetchPage, psiRunner: skipped, env: () => ({ PAGESPEED_API_KEY: 'K' }), now: NOW, limiter: fresh() });
    data = (await (await handler(post({ domain: 'primer.example', pagespeed: false }))).json()) as { audit: SiteAudit };
    expect(skipped).not.toHaveBeenCalled();
    expect(data.audit.psiStatus).toBe('skipped');
  });

  it('falls back to http when https cannot be reached', async () => {
    const fetchPage = pages({
      'https://plain.example/': new GuardError('network', 'x'),
      'http://plain.example/': { body: '<title>Plain</title>' },
    });
    const handler = createAuditHandler({ fetchPage, psiRunner: vi.fn(), env: () => ({}), now: NOW, limiter: fresh() });
    const { audit } = (await (await handler(post({ domain: 'plain.example' }))).json()) as { audit: SiteAudit };
    expect(audit.https).toBe(false);
    expect(audit.httpRedirectsToHttps).toBeNull();
  });

  it('rejects bad input, wrong methods, cross-origin calls and private targets', async () => {
    const handler = createAuditHandler({ fetchPage: pages({}), psiRunner: vi.fn(), env: () => ({}), limiter: fresh() });
    expect((await handler(new Request('https://app.test/api/audit'))).status).toBe(405);
    expect((await handler(post('{nope'))).status).toBe(400);
    expect((await handler(post({ domain: 42 }))).status).toBe(400);
    expect((await handler(post({ domain: 'localhost' }))).status).toBe(400);
    expect((await handler(post({ domain: 'x'.repeat(2000) }))).status).toBe(413);
    expect((await handler(post({ domain: 'a.example' }, { origin: 'https://evil.test' }))).status).toBe(403);
    for (const domain of ['127.0.0.1', 'printer.local', '169.254.169.254', 'example.internal']) {
      const res = await handler(post({ domain }));
      expect(res.status).toBe(400);
    }
  });

  it('maps guard errors to safe responses without internals', async () => {
    const cases: [Error, number][] = [
      [new GuardError('private_address', 'x'), 400],
      [new GuardError('too_many_redirects', 'x'), 422],
      [new GuardError('dns', 'x'), 422],
      [new Error('internal detail 10.0.0.1'), 502],
    ];
    for (const [error, status] of cases) {
      const fetchPage = pages({ 'https://x.example/': error, 'http://x.example/': error });
      const handler = createAuditHandler({ fetchPage, psiRunner: vi.fn(), env: () => ({}), limiter: fresh() });
      const res = await handler(post({ domain: 'x.example' }));
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain('10.0.0.1');
    }
  });

  it('rejects non-HTML pages and error statuses', async () => {
    let handler = createAuditHandler({
      fetchPage: pages({ 'https://x.example/': { skipped: 'content-type', contentType: 'application/pdf' } }),
      psiRunner: vi.fn(),
      env: () => ({}),
      limiter: fresh(),
    });
    expect((await handler(post({ domain: 'x.example' }))).status).toBe(422);
    handler = createAuditHandler({
      fetchPage: pages({ 'https://x.example/': { status: 403, body: '<html></html>' } }),
      psiRunner: vi.fn(),
      env: () => ({}),
      limiter: fresh(),
    });
    const res = await handler(post({ domain: 'x.example' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('403');
  });

  it('rate-limits per IP', async () => {
    const handler = createAuditHandler({
      fetchPage: pages({ 'https://primer.example/': { body: html } }),
      psiRunner: vi.fn(),
      env: () => ({}),
      limiter: new RateLimiter(2, 60_000),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await handler(post({ domain: 'primer.example' }))).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});
