import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_COUNT,
  MAX_PROMPT_COUNT,
  PROMPT_TEMPLATES,
  clampPromptCount,
  generatePrompts,
  sanitizePromptList,
} from '../src/lib/prompts.ts';
import { business } from './fixtures.ts';

describe('generatePrompts', () => {
  it('returns the default number of prompts', () => {
    expect(generatePrompts(business())).toHaveLength(DEFAULT_PROMPT_COUNT);
  });

  it('is deterministic for the same input', () => {
    const input = business({ competitors: ['Northpine Web'] });
    expect(generatePrompts(input, 12)).toEqual(generatePrompts(input, 12));
  });

  it('fills category, city and country and leaves no placeholders', () => {
    const prompts = generatePrompts(business(), MAX_PROMPT_COUNT);
    expect(prompts[0]).toBe('What is the best web design agency in Skopje?');
    expect(prompts[1]).toBe('Can you recommend a good web design agency in Skopje, North Macedonia?');
    for (const p of prompts) expect(p).not.toMatch(/[{}]/);
  });

  it('never includes the business name, so the assistant has to bring it up itself', () => {
    for (const p of generatePrompts(business(), MAX_PROMPT_COUNT)) {
      expect(p.toLowerCase()).not.toContain('example studio');
    }
  });

  it('skips competitor templates when there are no competitors', () => {
    const prompts = generatePrompts(business(), MAX_PROMPT_COUNT);
    const competitorTemplates = PROMPT_TEMPLATES.en.filter((t) => t.includes('{competitor}')).length;
    expect(prompts).toHaveLength(PROMPT_TEMPLATES.en.length - competitorTemplates);
    expect(prompts.some((p) => p.includes('alternatives to'))).toBe(false);
  });

  it('rotates through competitors when there are several', () => {
    const prompts = generatePrompts(business({ competitors: ['Northpine Web', 'Studio Lumen'] }), MAX_PROMPT_COUNT);
    expect(prompts).toContain('What are good alternatives to Northpine Web in Skopje?');
    expect(prompts).toContain('Is Studio Lumen the best web design agency in Skopje, or are there better options?');
  });

  it('caps the count at the maximum and at least one', () => {
    expect(generatePrompts(business({ competitors: ['A'] }), 99)).toHaveLength(MAX_PROMPT_COUNT);
    expect(generatePrompts(business(), 0)).toHaveLength(1);
    expect(clampPromptCount(Number.NaN)).toBe(DEFAULT_PROMPT_COUNT);
  });

  it('uses Macedonian templates when the language is mk', () => {
    const prompts = generatePrompts(business({ language: 'mk', category: 'веб дизајн', city: 'Скопје', country: 'Македонија' }), 3);
    expect(prompts[0]).toBe('Кој е најдобар за веб дизајн во Скопје?');
    expect(prompts[2]).toContain('Имам мал бизнис во Скопје');
  });

  it('drops the country cleanly when it is empty', () => {
    const prompts = generatePrompts(business({ country: '' }), 2);
    expect(prompts[1]).toBe('Can you recommend a good web design agency in Skopje?');
  });
});

describe('sanitizePromptList', () => {
  it('trims, removes empties and case-insensitive duplicates', () => {
    expect(sanitizePromptList(['  a  b ', '', 'A B', 'c'])).toEqual(['a b', 'c']);
  });

  it('caps length and count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `prompt ${i}`);
    expect(sanitizePromptList(many)).toHaveLength(MAX_PROMPT_COUNT);
    expect(sanitizePromptList(['x'.repeat(500)])[0]).toHaveLength(300);
  });
});
