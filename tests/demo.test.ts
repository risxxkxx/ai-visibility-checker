import { describe, expect, it } from 'vitest';
import { buildDemoReport, DEMO_ANSWERS, DEMO_PROMPTS } from '../src/demo/exampleStudio.ts';
import { reportToHtml } from '../src/lib/exportReport.ts';

describe('demo report', () => {
  const report = buildDemoReport();

  it('is flagged as demo data everywhere it can be exported', () => {
    expect(report.demo).toBe(true);
    expect(report.engines.every((e) => e.model?.startsWith('demo'))).toBe(true);
    expect(reportToHtml(report)).toContain('Demo data.');
  });

  it('covers every prompt for every engine', () => {
    expect(DEMO_PROMPTS).toHaveLength(8);
    expect(DEMO_ANSWERS).toHaveLength(24);
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
    expect(report.score.answered).toBe(23);
    expect(report.score.mentionedCount).toBe(13);
    expect(report.score.score).toBe(61);
    expect(report.score.band).toBe('visible');
    expect(report.shareOfVoice[0]!.name).toBe('Northpine Web');
    expect(report.recommendations[0]!.priority).toBe('high');
  });
});
