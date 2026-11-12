import { describe, expect, it } from 'vitest';
import {
  brandTokens,
  foldText,
  hostOf,
  levenshtein,
  normalizeDomain,
  skeletonWord,
  transliterate,
} from '../src/lib/normalize.ts';

describe('transliterate', () => {
  it('maps Macedonian Cyrillic to Latin and keeps capitalisation', () => {
    expect(transliterate('Скопје')).toBe('Skopje');
    expect(transliterate('Љубовна Њива')).toBe('Ljubovna Njiva');
  });

  it('leaves Latin text alone', () => {
    expect(transliterate('Example Studio')).toBe('Example Studio');
  });
});

describe('foldText / skeletonWord', () => {
  it('removes case and diacritics', () => {
    expect(foldText('ŠARENA Ḱesa')).toBe('sarena kesa');
  });

  it('gives the same skeleton for Cyrillic, diacritic Latin and informal Latin', () => {
    const forms = ['Шарена', 'Šarena', 'Sharena', 'sarena'];
    expect(new Set(forms.map(skeletonWord)).size).toBe(1);
    const kj = ['Ќеса', 'Ḱesa', 'Kjesa', 'Kesa'];
    expect(new Set(kj.map(skeletonWord)).size).toBe(1);
    const dzh = ['Џамлија', 'Džamlija', 'Dzhamlija'];
    expect(new Set(dzh.map(skeletonWord)).size).toBe(1);
  });
});

describe('brandTokens', () => {
  it('drops legal-form suffixes', () => {
    expect(brandTokens('Example Studio DOOEL').map((t) => t.key)).toEqual(['example', 'studio']);
    expect(brandTokens('Example Studio d.o.o.e.l.').map((t) => t.key)).toEqual(['example', 'studio']);
    expect(brandTokens('Пример Студио ДООЕЛ').map((t) => t.key)).toEqual(['primer', 'studio']);
  });

  it('keeps a name that is only a suffix-like word', () => {
    expect(brandTokens('AD').map((t) => t.key)).toEqual(['ad']);
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('exits early past the maximum', () => {
    expect(levenshtein('abcdef', 'uvwxyz', 1)).toBe(2);
  });
});

describe('normalizeDomain / hostOf', () => {
  it('strips protocol, www, path and port', () => {
    expect(normalizeDomain('https://www.ExampleStudio.example:443/contact?x=1')).toBe('examplestudio.example');
    expect(normalizeDomain('examplestudio.example/')).toBe('examplestudio.example');
  });

  it('rejects things that are not domains', () => {
    expect(normalizeDomain('not a domain')).toBe('');
    expect(normalizeDomain('')).toBe('');
  });

  it('reads hosts from URLs', () => {
    expect(hostOf('https://www.clutch.co/profile/x')).toBe('clutch.co');
    expect(hostOf('::::')).toBeNull();
  });
});
