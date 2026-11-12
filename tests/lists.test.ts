import { describe, expect, it } from 'vitest';
import { extractLists, findPosition, itemHead } from '../src/lib/lists.ts';
import { mentions } from '../src/lib/mention.ts';

const has = (name: string) => (t: string) => mentions(t, { name });

describe('extractLists', () => {
  it('reads numbered lists in several markdown styles', () => {
    const text = [
      'Here are some options:',
      '1. **Northpine Web** – strong on e-commerce',
      '2) Studio Lumen: branding first',
      '### 3. Example Studio',
      '**4.** Kamenko Digital',
    ].join('\n');
    const lists = extractLists(text);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.map((i) => i.position)).toEqual([1, 2, 3, 4]);
    expect(lists[0]![2]!.text).toBe('Example Studio');
  });

  it('uses order in the text, not the printed number', () => {
    const lists = extractLists('1. A\n2. B\n2. C\n4. D');
    expect(lists[0]!.map((i) => [i.position, i.text])).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'D'],
    ]);
  });

  it('starts a new list when numbering restarts', () => {
    const lists = extractLists('1. A\n2. B\n\nTips:\n1. Ask for a portfolio\n2. Check reviews');
    expect(lists).toHaveLength(2);
  });

  it('falls back to top-level bullets and ignores nested ones', () => {
    const text = '- Northpine Web\n  - good reviews\n- Example Studio\n  * fast\n- Studio Lumen';
    const lists = extractLists(text);
    expect(lists[0]!.map((i) => i.text)).toEqual(['Northpine Web', 'Example Studio', 'Studio Lumen']);
  });

  it('ignores bullets when there is a numbered list', () => {
    const text = '1. Northpine Web\n   - details\n2. Example Studio';
    expect(extractLists(text)[0]).toHaveLength(2);
  });

  it('reads markdown table rows as a list', () => {
    const text = '| Agency | Notes |\n|---|---|\n| Studio Lumen | brand |\n| Example Studio | web |';
    const lists = extractLists(text);
    expect(lists[0]!.map((i) => i.position)).toEqual([1, 2]);
    expect(lists[0]![1]!.text).toContain('Example Studio');
  });

  it('returns no lists for prose', () => {
    expect(extractLists('Example Studio is a good choice in Skopje.')).toEqual([]);
  });
});

describe('itemHead', () => {
  it('takes bold text or the part before a separator', () => {
    expect(itemHead('**Studio Lumen** – similar to Example Studio')).toBe('Studio Lumen');
    expect(itemHead('Studio Lumen - similar to Example Studio')).toBe('Studio Lumen');
    expect(itemHead('Studio Lumen: similar to Example Studio')).toBe('Studio Lumen');
    expect(itemHead('[Studio Lumen](https://x.test) – web')).toBe('Studio Lumen');
  });
});

describe('findPosition', () => {
  it('finds the rank of a business', () => {
    const lists = extractLists('1. Northpine Web\n2. Studio Lumen\n3. Example Studio');
    expect(findPosition(lists, has('Example Studio'))).toEqual({ position: 3, listLength: 3 });
  });

  it('does not take the rank of an item that only mentions the business in its description', () => {
    const lists = extractLists('1. **Studio Lumen** – a cheaper option than Example Studio\n2. **Example Studio** – premium');
    expect(findPosition(lists, has('Example Studio')).position).toBe(2);
  });

  it('falls back to the full item text when no head matches', () => {
    const lists = extractLists('1. **Agency pick** – Example Studio, for branding\n2. **Budget pick** – Studio Lumen');
    expect(findPosition(lists, has('Example Studio')).position).toBe(1);
  });

  it('returns null when not in a list', () => {
    const lists = extractLists('1. Northpine Web\n2. Studio Lumen');
    expect(findPosition(lists, has('Example Studio'))).toEqual({ position: null, listLength: 2 });
  });

  it('finds a Cyrillic list entry for a Latin brand', () => {
    const lists = extractLists('1. Студио Лумен\n2. Шарена Ќеса');
    expect(findPosition(lists, has('Sharena Kjesa')).position).toBe(2);
  });
});
