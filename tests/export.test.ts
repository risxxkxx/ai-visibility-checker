import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/lib/report.ts';
import { escapeHtml, reportFileName, reportToHtml, reportToJson } from '../src/lib/exportReport.ts';
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

  it('round-trips through JSON', () => {
    const r = report();
    expect(JSON.parse(reportToJson(r))).toEqual(r);
  });
});
