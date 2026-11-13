import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildPsiUrl, parsePsiResponse, runPsi} from '../server/audit/psi.mjs';
import {psiFindings} from '../server/audit/audit.mjs';

// Hand-written fixture following the documented response shape (see _fixtureNote inside).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/psi-response.fixture.json', import.meta.url), 'utf8'));

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});

describe('buildPsiUrl', () => {
  it('requests mobile strategy and the four categories', () => {
    const url = buildPsiUrl('https://oldsite.example/', 'KEY123');
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    expect(url.searchParams.get('url')).toBe('https://oldsite.example/');
    expect(url.searchParams.get('strategy')).toBe('MOBILE');
    expect(url.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']);
    expect(url.searchParams.get('key')).toBe('KEY123');
  });

  it('works without a key', () => {
    expect(buildPsiUrl('https://a.example/').searchParams.has('key')).toBe(false);
  });
});

describe('parsePsiResponse', () => {
  it('extracts category scores (0–100) and lab/field metrics', () => {
    const {ok, psi} = parsePsiResponse(fixture);
    expect(ok).toBe(true);
    expect(psi.categories).toEqual({performance:34, seo:72, accessibility:65, 'best-practices':78});
    expect(psi.metrics).toMatchObject({lcpMs:7912.5, cls:0.184, tbtMs:860, inpMs:340});
    expect(psi.display.lcp).toBe('7.9 s');
    expect(psi.fieldDataCategory).toBe('SLOW');
  });

  it('feeds findings with measured evidence only', () => {
    const findings = psiFindings(parsePsiResponse(fixture).psi);
    const evidence = findings.map((f) => f.evidence);
    expect(evidence).toEqual(expect.arrayContaining(['Performance 34/100 (PageSpeed, мобилен)', 'LCP 7.9 s', 'CLS 0.18', 'TBT 860 ms', 'INP 340 ms (реални корисници)']));
  });

  it('keeps null for missing scores and metrics', () => {
    const {psi} = parsePsiResponse({lighthouseResult:{categories:{performance:{score:null}, seo:{score:0.9}}, audits:{}}});
    expect(psi.categories).toEqual({performance:null, seo:90, accessibility:null, 'best-practices':null});
    expect(psi.metrics.lcpMs).toBeNull();
    expect(psi.metrics.inpMs).toBeNull();
  });

  it('reports Lighthouse runtime errors', () => {
    const result = parsePsiResponse({lighthouseResult:{runtimeError:{code:'FAILED_DOCUMENT_REQUEST', message:'x'}, categories:{}}});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('FAILED_DOCUMENT_REQUEST');
  });

  it('rejects empty or malformed bodies', () => {
    expect(parsePsiResponse(null).ok).toBe(false);
    expect(parsePsiResponse({lighthouseResult:{categories:{}}}).ok).toBe(false);
  });
});

describe('runPsi', () => {
  it('returns parsed data on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fixture));
    const result = await runPsi('https://oldsite.example/', {fetchImpl});
    expect(result.reason).toBeNull();
    expect(result.psi.categories.performance).toBe(34);
  });

  it('returns a reason (never the key) on quota errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({error:{message:'Quota exceeded for key SECRETKEY'}}, 429));
    const result = await runPsi('https://oldsite.example/', {apiKey:'SECRETKEY', fetchImpl});
    expect(result.psi).toBeNull();
    expect(result.reason).toMatch(/Квотата/);
    expect(result.reason).not.toContain('SECRETKEY');
  });

  it('returns a reason on timeout', async () => {
    const fetchImpl = (url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name:'AbortError'})));
    });
    const result = await runPsi('https://oldsite.example/', {fetchImpl, timeoutMs:20});
    expect(result).toEqual({psi:null, reason:'PageSpeed не одговори навреме.'});
  });

  it('returns a reason on network failure', async () => {
    const result = await runPsi('https://oldsite.example/', {fetchImpl:async () => { throw new Error('boom'); }});
    expect(result.psi).toBeNull();
    expect(result.reason).toBe('Неуспешно поврзување со PageSpeed.');
  });
});
