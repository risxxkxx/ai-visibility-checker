import { describe, expect, it } from 'vitest';
import { buildRecommendations, CATALOGUE } from '../src/lib/recommendations.ts';
import { computeScore, computeShareOfVoice } from '../src/lib/scoring.ts';
import type { AnswerAnalysis, BusinessInput, EngineId } from '../src/lib/types.ts';
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
const named = (engine: EngineId, position: number | null = 1) =>
  a(engine, { mentioned: true, matchType: 'exact', matchedText: 'x', position, listLength: position ? 5 : 0 });

function run(analyses: AnswerAnalysis[], input: BusinessInput = business(), cited: { domain: string; count: number }[] = []) {
  const score = computeScore(analyses);
  return buildRecommendations({
    business: input,
    analyses,
    score,
    shareOfVoice: computeShareOfVoice(analyses, input),
    topCitedDomains: cited,
  });
}

const byId = (recs: ReturnType<typeof run>) => Object.fromEntries(recs.map((r) => [r.id, r]));

describe('buildRecommendations', () => {
  it('returns nothing when no engine answered', () => {
    expect(run([a('openai', { ok: false })])).toEqual([]);
  });

  it('puts the fundamentals at high priority when the business is invisible', () => {
    const recs = byId(run([a('openai'), a('anthropic'), a('openai'), a('anthropic')]));
    expect(recs['google-business-profile']!.priority).toBe('high');
    expect(recs['schema-localbusiness']!.priority).toBe('high');
    expect(recs['service-pages']!.priority).toBe('high');
    expect(recs['google-business-profile']!.reason).toContain('Named in 0 of 4 answers (0%)');
  });

  it('keeps maintenance items low when the business is leading', () => {
    const recs = byId(run([named('openai'), named('anthropic'), named('perplexity')]));
    expect(recs['google-business-profile']!.priority).toBe('low');
    expect(recs['schema-localbusiness']!.priority).toBe('low');
    expect(recs['consistent-nap']!.priority).toBe('low');
    expect(recs['llms-txt']!.priority).toBe('low');
    expect(recs.reviews).toBeUndefined();
    expect(recs['service-pages']).toBeUndefined();
  });

  it('flags reviews when a competitor is named more often', () => {
    const input = business({ competitors: ['Northpine Web'] });
    const recs = byId(
      run(
        [
          { ...named('openai', 2), competitors: [{ name: 'Northpine Web', position: 1 }] },
          { ...a('anthropic'), competitors: [{ name: 'Northpine Web', position: 1 }] },
        ],
        input,
      ),
    );
    expect(recs.reviews!.priority).toBe('high');
    expect(recs.reviews!.reason).toContain('Northpine Web was named 2 times against your 1');
  });

  it('flags inconsistent details when only some engines name the business', () => {
    const recs = byId(run([named('openai'), named('openai'), a('anthropic'), named('openai')]));
    expect(recs['consistent-nap']!.priority).toBe('high');
    expect(recs['consistent-nap']!.reason).toContain('Named by ChatGPT but not by Claude');
  });

  it('recommends directories from the sources engines actually cited', () => {
    const recs = byId(
      run(
        [a('perplexity', { citations: ['https://clutch.co/x'] }), named('openai')],
        business(),
        [
          { domain: 'clutch.co', count: 3 },
          { domain: 'examplestudio.example', count: 1 },
          { domain: 'yelp.test', count: 1 },
        ],
      ),
    );
    const dir = recs['directory-citations']!;
    expect(dir.priority).toBe('high');
    expect(dir.reason).toContain('clutch.co, yelp.test');
    expect(dir.reason).not.toContain('examplestudio.example');
    expect(dir.steps[0]).toBe('Check whether you are listed on: clutch.co, yelp.test.');
  });

  it('adds Macedonian content only for Macedonian runs with low visibility', () => {
    const mk = byId(run([a('openai'), a('anthropic')], business({ language: 'mk' })));
    expect(mk['local-language-content']!.priority).toBe('high');
    const en = byId(run([a('openai'), a('anthropic')]));
    expect(en['local-language-content']).toBeUndefined();
  });

  it('sorts by priority and only uses catalogue titles', () => {
    const recs = run([named('openai', 4), a('anthropic'), a('perplexity', { citations: ['https://x.test'] })]);
    const ranks = recs.map((r) => ({ high: 0, medium: 1, low: 2 })[r.priority]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    for (const r of recs) expect(r.title).toBe(CATALOGUE[r.id].title);
  });

  it('is deterministic', () => {
    const analyses = [named('openai', 3), a('anthropic')];
    expect(run(analyses)).toEqual(run(analyses));
  });
});
