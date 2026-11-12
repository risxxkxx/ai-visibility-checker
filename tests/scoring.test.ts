import { describe, expect, it } from 'vitest';
import { computeScore, computeShareOfVoice, positionValue, scoreBand } from '../src/lib/scoring.ts';
import type { AnswerAnalysis, EngineId } from '../src/lib/types.ts';
import { business } from './fixtures.ts';

function a(engine: EngineId, overrides: Partial<AnswerAnalysis> = {}): AnswerAnalysis {
  return {
    engine,
    prompt: 'p',
    ok: true,
    mentioned: false,
    matchType: null,
    matchedText: null,
    position: null,
    listLength: 0,
    competitors: [],
    citations: [],
    domainCited: false,
    ...overrides,
  };
}

const named = (engine: EngineId, position: number | null, listLength = position === null ? 0 : 5) =>
  a(engine, { mentioned: true, matchType: 'exact', matchedText: 'Example Studio', position, listLength });

describe('positionValue', () => {
  it('rewards higher ranks', () => {
    expect(positionValue(named('openai', 1))).toBe(1);
    expect(positionValue(named('openai', 2))).toBe(0.85);
    expect(positionValue(named('openai', 3))).toBe(0.7);
    expect(positionValue(named('openai', 5))).toBe(0.45);
    expect(positionValue(named('openai', 8))).toBe(0.3);
    expect(positionValue(named('openai', 12))).toBe(0.2);
  });

  it('values prose mentions, and less so when a ranked list left the business out', () => {
    expect(positionValue(named('openai', null, 0))).toBe(0.6);
    expect(positionValue(named('openai', null, 5))).toBe(0.35);
    expect(positionValue(a('openai'))).toBe(0);
  });
});

describe('computeScore', () => {
  it('is 100 when named first by every engine on every prompt', () => {
    const s = computeScore([named('openai', 1), named('anthropic', 1), named('perplexity', 1)]);
    expect(s.score).toBe(100);
    expect(s.band).toBe('leading');
    expect(s.averagePosition).toBe(1);
  });

  it('is 0 when never named', () => {
    const s = computeScore([a('openai'), a('anthropic')]);
    expect(s.score).toBe(0);
    expect(s.band).toBe('invisible');
    expect(s.averagePosition).toBeNull();
  });

  it('follows the documented formula', () => {
    // 4 answers from 2 engines; named twice, both by openai, at ranks 1 and 3.
    const s = computeScore([named('openai', 1), named('openai', 3), a('openai'), a('anthropic')]);
    // M = 2/4, P = (1 + 0.7) / 4 = 0.425, C = 1/2
    // score = 100 × (0.5×0.5 + 0.3×0.425 + 0.2×0.5) = 47.75 -> 48
    expect(s.mentionRate).toBe(0.5);
    expect(s.positionScore).toBe(0.425);
    expect(s.engineCoverage).toBe(0.5);
    expect(s.score).toBe(48);
    expect(s.band).toBe('visible');
    expect(s.averagePosition).toBe(2);
  });

  it('leaves failed calls out of the denominators', () => {
    const s = computeScore([named('openai', 1), a('anthropic', { ok: false })]);
    expect(s.answered).toBe(1);
    expect(s.enginesAnswered).toBe(1);
    expect(s.score).toBe(100);
  });

  it('handles an empty run', () => {
    expect(computeScore([]).score).toBe(0);
  });
});

describe('scoreBand', () => {
  it('maps score ranges to bands', () => {
    expect(scoreBand(0)).toBe('invisible');
    expect(scoreBand(19)).toBe('invisible');
    expect(scoreBand(20)).toBe('emerging');
    expect(scoreBand(45)).toBe('visible');
    expect(scoreBand(70)).toBe('leading');
  });
});

describe('computeShareOfVoice', () => {
  it('splits mentions between the business and competitors', () => {
    const input = business({ competitors: ['Northpine Web', 'Studio Lumen'] });
    const rows = computeShareOfVoice(
      [
        { ...named('openai', 2), competitors: [{ name: 'Northpine Web', position: 1 }] },
        { ...a('anthropic'), competitors: [{ name: 'Northpine Web', position: 1 }, { name: 'Studio Lumen', position: null }] },
        { ...a('perplexity', { ok: false }), competitors: [{ name: 'Studio Lumen', position: 1 }] },
      ],
      input,
    );
    expect(rows.map((r) => [r.name, r.mentions, r.share])).toEqual([
      ['Northpine Web', 2, 0.5],
      ['Example Studio', 1, 0.25],
      ['Studio Lumen', 1, 0.25],
    ]);
    expect(rows[0]!.averagePosition).toBe(1);
    expect(rows[0]!.engines).toEqual(['openai', 'anthropic']);
    expect(rows[1]!.isYou).toBe(true);
  });

  it('returns zero shares when nobody is named', () => {
    const rows = computeShareOfVoice([a('openai')], business({ competitors: ['Northpine Web'] }));
    expect(rows.every((r) => r.share === 0)).toBe(true);
  });
});
