import { describe, expect, it } from 'vitest';
import { buildDemoReport, DEMO_ANSWERS, DEMO_PROMPTS } from '../src/demo/exampleStudio.ts';
import { reportToHtml } from '../src/lib/exportReport.ts';

describe('demo report', () => {
  const report = buildDemoReport();

  it('is flagged as demo data everywhere it can be exported', () => {
    expect(report.demo).toBe(true);
    expect(report.engines.every((e) => e.model?.startsWith('demo'))).toBe(true);
    expect(reportToHtml(report)).toContain('Demo data.');
    expect(reportToHtml(report, 'mk')).toContain('Демо податоци.');
    expect(report.audit!.domain).toBe('examplestudio.example');
    expect(report.audit!.finalUrl.startsWith('https://examplestudio.example/')).toBe(true);
  });

  it('shows the fact check and website readiness on fictional data', () => {
    expect(report.knownFacts!.officialName).toBe('Example Studio');
    const wrong = report.factCheck.claims.filter((c) => c.status === 'possibly-wrong');
    expect(wrong.map((c) => [c.engine, c.value])).toEqual([['gemini', '€300–400 per month']]);
    expect(report.factCheck.claims.some((c) => c.engine === 'openai' && c.value === '€190' && c.status === 'correct')).toBe(true);
    expect(report.factCheck.accuracy.score).toBe(83);
    expect(report.factCheck.nameVariants.find((v) => v.name === 'Example Studio Digital Agency')!.kind).toBe('other');
    expect(report.readiness.score).toBeGreaterThan(0);
    expect(report.readiness.score).toBeLessThan(100);
    expect(report.recommendations[0]!.id).toBe('fix-wrong-facts');
    expect(report.recommendations.some((r) => r.status === 'done')).toBe(true);
  });

  it('covers every prompt for every engine', () => {
    expect(DEMO_PROMPTS).toHaveLength(8);
    expect(DEMO_ANSWERS).toHaveLength(32);
    expect(new Set(DEMO_ANSWERS.map((a) => a.engine))).toEqual(new Set(['openai', 'gemini', 'anthropic', 'perplexity']));
  });

  it('only uses reserved .example domains for the fictional businesses', () => {
    expect(report.business.domain.endsWith('.example')).toBe(true);
    for (const url of DEMO_ANSWERS.flatMap((a) => a.citations)) {
      const host = new URL(url).hostname;
      const isDirectory = ['clutch.co', 'www.goodfirms.co', 'www.designrush.com'].includes(host);
      expect(isDirectory || host.endsWith('.example')).toBe(true);
    }
  });

  it('exercises the analyzers end to end', () => {
    // A typo match ("Exampel Studio"), an alias, a table, a prose mention and a failed call are all in the data.
    expect(report.analyses.some((a) => a.matchType === 'fuzzy')).toBe(true);
    expect(report.analyses.some((a) => a.ok && a.mentioned && a.position === null)).toBe(true);
    expect(report.analyses.filter((a) => !a.ok)).toHaveLength(1);
    expect(report.score.answered).toBe(31);
    expect(report.score.mentionedCount).toBe(20);
    expect(report.score.score).toBe(67);
    expect(report.score.band).toBe('visible');
    expect(report.shareOfVoice[0]!.name).toBe('Northpine Web');
    expect(report.recommendations[0]!.priority).toBe('high');
  });
});
