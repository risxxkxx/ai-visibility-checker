import { describe, expect, it } from 'vitest';
import { analyzeAnswer, topCitedDomains } from '../src/lib/analyze.ts';
import type { EngineAnswer } from '../src/lib/types.ts';
import { business } from './fixtures.ts';
import { highlight, plainAnswer } from '../src/lib/highlight.ts';
import { splitList, validateBusiness } from '../src/lib/validation.ts';

function answer(text: string, overrides: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    engine: 'perplexity',
    model: 'test',
    prompt: 'best web design agency in Skopje',
    ok: true,
    text,
    citations: [],
    latencyMs: 1,
    ...overrides,
  };
}

describe('analyzeAnswer', () => {
  const input = business({ competitors: ['Northpine Web', 'Studio Lumen', 'Kamenko Digital'] });

  it('extracts mention, rank and competitors', () => {
    const a = analyzeAnswer(
      answer('Top agencies:\n1. **Northpine Web** – e-commerce\n2. **Example Studio** – branding\n3. **Studio Lumen** – UX'),
      input,
    );
    expect(a.mentioned).toBe(true);
    expect(a.position).toBe(2);
    expect(a.listLength).toBe(3);
    expect(a.competitors).toEqual([
      { name: 'Northpine Web', position: 1 },
      { name: 'Studio Lumen', position: 3 },
    ]);
  });

  it('marks a mention in prose with no rank', () => {
    const a = analyzeAnswer(answer('Many people like Example Studio for small sites.'), input);
    expect(a.mentioned).toBe(true);
    expect(a.position).toBeNull();
  });

  it('flags when the business domain is cited as a source', () => {
    const a = analyzeAnswer(
      answer('Northpine Web is popular.', {
        citations: ['https://clutch.co/mk/agencies', 'https://www.examplestudio.example/about'],
      }),
      input,
    );
    expect(a.mentioned).toBe(false);
    expect(a.domainCited).toBe(true);
  });

  it('handles failed engine calls', () => {
    const a = analyzeAnswer(answer('', { ok: false, error: 'timeout' }), input);
    expect(a.ok).toBe(false);
    expect(a.mentioned).toBe(false);
    expect(a.competitors).toEqual([]);
  });
});

describe('topCitedDomains', () => {
  it('counts each domain once per answer and sorts by count', () => {
    const result = topCitedDomains([
      answer('', { citations: ['https://clutch.co/a', 'https://clutch.co/b', 'https://x.test'] }),
      answer('', { citations: ['https://www.clutch.co/c'] }),
    ]);
    expect(result).toEqual([
      { domain: 'clutch.co', count: 2 },
      { domain: 'x.test', count: 1 },
    ]);
  });
});


describe('highlight', () => {
  it('marks brand and competitor occurrences without overlaps', () => {
    const segs = highlight('Example Studio and example studio beat Studio Lumen.', [
      { text: 'Example Studio', kind: 'you' },
      { text: 'Studio', kind: 'competitor' },
      { text: 'Studio Lumen', kind: 'competitor' },
    ]);
    expect(segs.filter((s) => s.kind).map((s) => [s.text, s.kind])).toEqual([
      ['Example Studio', 'you'],
      ['example studio', 'you'],
      ['Studio Lumen', 'competitor'],
    ]);
    expect(segs.map((s) => s.text).join('')).toBe('Example Studio and example studio beat Studio Lumen.');
  });

  it('strips markdown emphasis and headings', () => {
    expect(plainAnswer('### Top\n1. **Example Studio**')).toBe('Top\n1. Example Studio');
  });
});

describe('validation', () => {
  it('splits lists and validates the business form', () => {
    expect(splitList('A, B\nA,, C', 5, 80)).toEqual(['A', 'B', 'C']);
    expect(validateBusiness(business())).toEqual({});
    const errors = validateBusiness(business({ name: ' ', domain: 'not a domain' }));
    expect(Object.keys(errors).sort()).toEqual(['domain', 'name']);
  });
});
