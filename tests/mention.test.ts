import { describe, expect, it } from 'vitest';
import { detectMention, findDomain } from '../src/lib/mention.ts';

const brand = { name: 'Example Studio', domain: 'examplestudio.example' };

describe('detectMention', () => {
  it('finds an exact mention', () => {
    const r = detectMention('I would start with Example Studio, they are solid.', brand);
    expect(r).toEqual({ mentioned: true, matchType: 'exact', matchedText: 'Example Studio' });
  });

  it('is case-insensitive (normalized match)', () => {
    const r = detectMention('EXAMPLE STUDIO is popular in Skopje.', brand);
    expect(r.mentioned).toBe(true);
    expect(r.matchType).toBe('normalized');
    expect(r.matchedText).toBe('EXAMPLE STUDIO');
  });

  it('ignores markdown and punctuation around the name', () => {
    expect(detectMention('1. **Example Studio** – branding', brand).matchType).toBe('exact');
    expect(detectMention('(Example-Studio)', brand).matchType).toBe('exact');
  });

  it('matches joined and split spellings', () => {
    expect(detectMention('Try ExampleStudio for this.', brand).matchType).toBe('normalized');
    expect(detectMention('Ask Data Forge', { name: 'DataForge' }).matchType).toBe('normalized');
  });

  it('matches across diacritics', () => {
    const r = detectMention('Preporaka: Šarena Kesa dizajn.', { name: 'Sarena Kesa' });
    expect(r.matchType).toBe('normalized');
    expect(r.matchedText).toBe('Šarena Kesa');
  });

  it('matches a Latin brand written in Macedonian Cyrillic', () => {
    const r = detectMention('Најдобри се Шарена Ќеса и уште неколку агенции.', { name: 'Sharena Kjesa' });
    expect(r.mentioned).toBe(true);
    expect(r.matchedText).toBe('Шарена Ќеса');
  });

  it('matches a Cyrillic brand written in Latin', () => {
    const r = detectMention('Top picks: Strumica Dizajn and others.', { name: 'Струмица Дизајн' });
    expect(r.matchType).toBe('normalized');
  });

  it('uses aliases', () => {
    const r = detectMention('Препорачувам Егзампл Студио.', { ...brand, aliases: ['Егзампл Студио'] });
    expect(r.matchType).toBe('exact');
  });

  it('tolerates a small typo in longer names (fuzzy)', () => {
    const r = detectMention('Consider Exampel Studio for design.', brand);
    expect(r.matchType).toBe('fuzzy');
    expect(r.matchedText).toBe('Exampel Studio');
  });

  it('does not fuzzy-match short names', () => {
    expect(detectMention('We used Nola last year.', { name: 'Nula' }).mentioned).toBe(false);
  });

  it('does not match a name that is only part of a longer word', () => {
    expect(detectMention('Examples of studios in town.', { name: 'Example Studio' }).mentioned).toBe(false);
  });

  it('falls back to the domain when the name is absent', () => {
    const r = detectMention('See https://www.examplestudio.example/work for details.', brand);
    expect(r.matchType).toBe('domain');
  });

  it('prefers a name match over a domain match', () => {
    const r = detectMention('Example Studio (examplestudio.example)', brand);
    expect(r.matchType).toBe('exact');
  });

  it('reports no mention when absent', () => {
    expect(detectMention('Northpine Web and Studio Lumen are good.', brand)).toEqual({
      mentioned: false,
      matchType: null,
      matchedText: null,
    });
    expect(detectMention('', brand).mentioned).toBe(false);
  });
});

describe('findDomain', () => {
  it('matches subdomains but not look-alike domains', () => {
    expect(findDomain('blog.examplestudio.example', 'examplestudio.example')).toBe('blog.examplestudio.example');
    expect(findDomain('notexamplestudio.example', 'examplestudio.example')).toBeNull();
    expect(findDomain('examplestudio.example.evil.test', 'examplestudio.example')).toBeNull();
  });
});
