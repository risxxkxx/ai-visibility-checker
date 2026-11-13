import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/lib/report.ts';
import { escapeHtml, reportFileName, reportToHtml, reportToJson, snippetHtml } from '../src/lib/exportReport.ts';
import type { EngineAnswer } from '../src/lib/types.ts';
import { business } from './fixtures.ts';

const answers: EngineAnswer[] = [
  {
    engine: 'openai',
    model: 'm',
    prompt: 'best agency?',
    ok: true,
    text: '1. **Example Studio** – good\n2. <script>alert(1)</script> Studio Lumen',
    citations: [],
    latencyMs: 1,
  },
];

function report(demo = false) {
  return buildReport({
    business: business({ name: 'Example <Studio>', aliases: ['Example Studio'], competitors: ['Studio Lumen'] }),
    prompts: ['best agency?'],
    engines: [{ id: 'openai', label: 'ChatGPT', available: true, model: 'm' }],
    answers,
    demo,
    generatedAt: '2026-11-12T10:00:00.000Z',
  });
}

describe('report export', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('produces a standalone HTML report with no unescaped answer markup', () => {
    const html = reportToHtml(report());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<mark class="you">Example Studio</mark>');
    expect(html).toContain('<mark class="competitor">Studio Lumen</mark>');
    expect(html).toContain('Example &lt;Studio&gt;');
    expect(html).not.toContain('Demo data.');
  });

  it('labels demo reports in the HTML and the file name', () => {
    const r = report(true);
    expect(reportToHtml(r)).toContain('Demo data.');
    expect(reportFileName(r, 'json')).toBe('ai-visibility-example-studio-2026-11-12-demo.json');
  });

  it('renders the report in Macedonian with a Macedonian file name', () => {
    const r = report(true);
    const html = reportToHtml(r, 'mk');
    expect(html).toContain('<html lang="mk">');
    expect(html).toContain('Извештај за видливост во AI');
    expect(html).toContain('Што да поправите, по редослед');
    expect(html).toContain('Демо податоци.');
    expect(html).not.toContain('What to fix, in order');
    expect(reportFileName(r, 'html', 'mk')).toBe('ai-visibility-example-studio-2026-11-12-demo-mk.html');
    // Recommendation text switches language too.
    expect(html).toContain(r.recommendations[0]!.title.mk);
    expect(html).not.toContain(r.recommendations[0]!.title.en);
  });

  it('includes the facts and audit sections and escapes snippets', () => {
    const html = reportToHtml(report());
    expect(html).toContain('Facts AI states about you');
    expect(html).toContain('Website readiness');
    expect(html).toContain('The website audit was turned off for this run.');
    expect(
      snippetHtml({ text: '<b>Example</b> from €190', highlights: [{ start: 20, end: 24, kind: 'claim' }] }),
    ).toBe('&lt;b&gt;Example&lt;/b&gt; from <mark class="claim">€190</mark>');
  });

  it('round-trips through JSON', () => {
    const r = report();
    expect(JSON.parse(reportToJson(r))).toEqual(r);
  });
});
