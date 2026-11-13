import { describe, expect, it } from 'vitest';
import {
  brandWindows,
  checkFacts,
  comparePrice,
  describeWrongClaim,
  extractMoney,
  extractPhones,
  findSpans,
  formatPriceFact,
  hasKnownFacts,
  parseAmount,
  phoneKey,
  samePhone,
  segmentBlocks,
  variantAt,
} from '../src/lib/facts.ts';
import { analyzeAnswers } from '../src/lib/analyze.ts';
import type { EngineAnswer, EngineId, KnownFacts } from '../src/lib/types.ts';
import { business } from './fixtures.ts';

const NULA = business({ name: 'NULA', domain: 'agencynula.com', category: 'web design agency', competitors: ['Studio Lumen', 'Kamenko Digital'] });

const FACTS: KnownFacts = {
  officialName: 'NULA',
  nameVariants: ['НУЛА'],
  phones: ['073 745 473'],
  prices: [
    { label: 'One Page website', amount: 190, currency: 'EUR', perMonth: false },
    { label: 'Social media management', amount: 150, currency: 'EUR', perMonth: true },
  ],
  city: 'Skopje',
  address: 'ул. Македонија 12',
};

function answer(engine: EngineId, text: string, ok = true): EngineAnswer {
  return { engine, model: 'm', prompt: 'Who should build my website in Skopje?', ok, text, citations: [], latencyMs: 1 };
}

function run(answers: EngineAnswer[], facts: KnownFacts | null = FACTS, b = NULA) {
  return checkFacts({ business: b, facts, answers, analyses: analyzeAnswers(answers, b) });
}

/** ChatGPT, manual test: NULA first, correct phone and the One Page price, but a longer name. */
const CHATGPT_EN = `Here are web design agencies in Skopje worth contacting:

1. **NULA Digital Agency** – modern websites and branding for small businesses. Websites start from €190 (One Page package). Phone: 073 745 473.
2. **Studio Lumen** – branding-led studio, projects from €900.
3. **Kamenko Digital** – budget sites from €250.`;

/** Gemini, manual test: knows NULA, but quotes a generic social-media price. */
const GEMINI_MK = `Еве неколку агенции во Скопје:

**1. NULA**
* **Услуги:** веб дизајн, брендирање и социјални мрежи.
* **Цени:** Управувањето со социјални мрежи обично чини €300–400+ месечно.

**2. Studio Lumen**
* **Цени:** од 250 €`;

const GEMINI_EN = `**NULA** is a Skopje agency for websites and social media. Social media management there typically costs €300-400/month, depending on the number of posts.`;

describe('extractMoney', () => {
  const one = (s: string) => {
    const hits = extractMoney(s);
    expect(hits).toHaveLength(1);
    return hits[0]!;
  };

  it('reads euro amounts written in common ways', () => {
    expect(one('Websites from €190.').price).toEqual({ min: 190, max: null, currency: 'EUR', perMonth: false, from: true });
    expect(one('цена 190 € за сајт').price).toMatchObject({ min: 190, currency: 'EUR', from: false });
    expect(one('од 190 евра').price).toMatchObject({ min: 190, currency: 'EUR', from: true });
    expect(one('190 EUR').price.min).toBe(190);
    expect(one('EUR 1.200').price.min).toBe(1200);
    expect(one('€1,200.50 total').price.min).toBe(1200.5);
    expect(one('starting at 1 200 € ').price).toMatchObject({ min: 1200, from: true });
  });

  it('reads ranges in one or two parts', () => {
    expect(one('190-300 €').price).toMatchObject({ min: 190, max: 300 });
    expect(one('€300–400+ месечно').price).toMatchObject({ min: 300, max: 400, perMonth: true, from: true });
    expect(one('€300 – €400 per month').price).toMatchObject({ min: 300, max: 400, perMonth: true });
    expect(one('300 € – 400 € a month').price).toMatchObject({ min: 300, max: 400, perMonth: true });
    expect(one('од 300 до 400 евра').price).toMatchObject({ min: 300, max: 400, from: true });
  });

  it('detects per-month wording in English and Macedonian', () => {
    expect(one('€150/month').price.perMonth).toBe(true);
    expect(one('€150/mo').price.perMonth).toBe(true);
    expect(one('150 € месечно').price.perMonth).toBe(true);
    expect(one('150 € на месец').price.perMonth).toBe(true);
    expect(one('a monthly fee of €150').price.perMonth).toBe(true);
    expect(one('месечна претплата од 150 €').price).toMatchObject({ perMonth: true, from: true });
    expect(one('€150 for the logo').price.perMonth).toBe(false);
  });

  it('reads denars and dollars', () => {
    expect(one('од 12.000 денари').price).toMatchObject({ min: 12000, currency: 'MKD', from: true });
    expect(one('12 000 ден.').price).toMatchObject({ min: 12000, currency: 'MKD' });
    expect(one('5000 MKD').price.currency).toBe('MKD');
    expect(one('$500').price).toMatchObject({ min: 500, currency: 'USD' });
  });

  it('ignores numbers that are not money', () => {
    expect(extractMoney('Founded in 2019, 12 people, rated 4.9, call 073 745 473.')).toEqual([]);
    expect(extractMoney('денес и 5 денови')).toEqual([]);
  });

  it('parses grouped and decimal amounts', () => {
    expect(parseAmount('12.000')).toBe(12000);
    expect(parseAmount('1,200')).toBe(1200);
    expect(parseAmount('190,5')).toBe(190.5);
    expect(parseAmount('190.50')).toBe(190.5);
  });
});

describe('phones', () => {
  it('extracts Macedonian numbers in local and international form', () => {
    const raws = extractPhones('Call 073 745 473, +389 73 745 473, 073/745-473 or (02) 3123 456. In 2019-2024 they grew.').map((p) => p.raw);
    expect(raws).toEqual(['073 745 473', '+389 73 745 473', '073/745-473', '(02) 3123 456']);
  });

  it('handles the (0) trunk prefix and numbers without spaces', () => {
    expect(extractPhones('Tel +389 (0)73 745 473 or 073745473, on 2.5.2024.').map((p) => p.raw)).toEqual(['+389 (0)73 745 473', '073745473']);
    expect(samePhone('+389 (0)73 745 473', '073 745 473')).toBe(true);
    expect(samePhone('073745473', '073 745 473')).toBe(true);
  });

  it('compares numbers by their national digits', () => {
    expect(phoneKey('+389 73 745 473')).toBe('73745473');
    expect(phoneKey('0038973745473')).toBe('73745473');
    expect(samePhone('073 745 473', '+389 73 745 473')).toBe(true);
    expect(samePhone('073 745 473', '073/745-473')).toBe(true);
    expect(samePhone('073 745 473', '02 3123 456')).toBe(false);
  });
});

describe('segmentation and windows', () => {
  it('keeps Gemini-style bullets under their bold heading', () => {
    const blocks = segmentBlocks(GEMINI_MK).map((b) => GEMINI_MK.slice(b.start, b.end));
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('€300–400+');
    expect(blocks[2]).toContain('Studio Lumen');
  });

  it('splits numbered lists into items and ends the list at a following paragraph', () => {
    const text = 'Intro.\n\n1. A – x\n   more about A\n2. B – y\n\nSummary paragraph.';
    const blocks = segmentBlocks(text).map((b) => text.slice(b.start, b.end).trim());
    expect(blocks).toEqual(['Intro.', '1. A – x\n   more about A', '2. B – y', 'Summary paragraph.']);
  });

  it('cuts the window at a competitor named in the same sentence', () => {
    const text = 'NULA has websites from €190, while Kamenko Digital charges €500 for the same.';
    const w = brandWindows(text, findSpans(text, 'NULA'), findSpans(text, 'Kamenko Digital'));
    expect(text.slice(w[0]!.start, w[0]!.end)).toBe('NULA has websites from €190, while ');
  });

  it('finds whole-word spans only', () => {
    expect(findSpans('NULA, nula and NULAX', 'NULA')).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ]);
  });
});

describe('comparePrice', () => {
  const stated = (min: number, perMonth = false, currency: 'EUR' | 'MKD' | 'USD' = 'EUR') => ({ min, max: null, currency, perMonth, from: true });

  it('matches by amount within tolerance and by label words', () => {
    expect(comparePrice(stated(190), FACTS.prices, 'websites from')).toEqual({ status: 'correct', factIndex: 0 });
    expect(comparePrice(stated(199), FACTS.prices, 'sajt')).toEqual({ status: 'correct', factIndex: 0 });
    expect(comparePrice(stated(12000, false, 'MKD'), FACTS.prices, 'веб-страници')).toEqual({ status: 'correct', factIndex: 0 });
    expect(comparePrice(stated(300, true), FACTS.prices, 'social media')).toEqual({ status: 'possibly-wrong', factIndex: 1 });
  });

  it('cannot verify what it has nothing to compare with', () => {
    expect(comparePrice(stated(300, true), [FACTS.prices[0]!], 'social media')).toEqual({ status: 'unverified', factIndex: null });
    expect(comparePrice(stated(300, false, 'USD'), FACTS.prices, 'web')).toEqual({ status: 'unverified', factIndex: null });
  });

  it('flags a price that matches none of several items without picking one', () => {
    const prices = [...FACTS.prices, { label: 'Online store', amount: 590, currency: 'EUR' as const, perMonth: false }];
    expect(comparePrice(stated(1000), prices, 'they also do')).toEqual({ status: 'possibly-wrong', factIndex: null });
  });
});

describe('checkFacts with the manual-test answers', () => {
  it('ChatGPT: the €190 price and the phone are correct; the name is a variant', () => {
    const r = run([answer('openai', CHATGPT_EN)]);
    expect(r.answersChecked).toBe(1);
    const price = r.claims.find((c) => c.kind === 'price')!;
    expect(price).toMatchObject({ value: '€190', status: 'correct', factKey: 'price:0', engine: 'openai' });
    expect(r.claims.find((c) => c.kind === 'phone')).toMatchObject({ value: '073 745 473', status: 'correct', factKey: 'phone:0' });
    // Competitor prices in other list items are not attributed to NULA.
    expect(r.claims.filter((c) => c.kind === 'price')).toHaveLength(1);
    expect(r.nameVariants).toEqual([{ name: 'NULA Digital Agency', count: 1, engines: ['openai'], kind: 'other' }]);
    expect(r.accuracy).toEqual({ correct: 2, wrong: 0, score: 100 });
  });

  it('Gemini (Macedonian): €300–400 per month is possibly wrong against €150/month', () => {
    const r = run([answer('gemini', GEMINI_MK)]);
    const prices = r.claims.filter((c) => c.kind === 'price');
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ value: '€300–400+ месечно', status: 'possibly-wrong', factKey: 'price:1' });
    expect(prices[0]!.price).toMatchObject({ min: 300, max: 400, perMonth: true });
    const row = r.rows.find((x) => x.key === 'price:1')!;
    expect(row).toMatchObject({ status: 'possibly-wrong', wrong: 1, engines: ['gemini'] });
    expect(row.expected).toEqual({ en: 'from €150/month', mk: 'од €150 месечно' });
    expect(r.rows.find((x) => x.key === 'price:0')!.status).toBe('not-mentioned');
    expect(r.accuracy.score).toBe(0);
    expect(r.nameVariants[0]).toMatchObject({ name: 'NULA', kind: 'official' });
  });

  it('Gemini (English): same case with "/month"', () => {
    const r = run([answer('gemini', GEMINI_EN)]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ kind: 'price', status: 'possibly-wrong', factKey: 'price:1' });
    const sentence = describeWrongClaim(r.claims[0]!, FACTS, 'Gemini');
    expect(sentence.en).toBe('Gemini stated "€300-400/month"; your price for Social media management is from €150/month.');
    expect(sentence.mk).toBe('Gemini наведе „€300-400/month“; вашата цена за Social media management е од €150 месечно.');
  });

  it('combines engines into accuracy and per-fact rows', () => {
    const r = run([answer('openai', CHATGPT_EN), answer('gemini', GEMINI_MK), answer('anthropic', 'No idea who is best.')]);
    expect(r.answersChecked).toBe(2);
    expect(r.accuracy).toEqual({ correct: 2, wrong: 1, score: 67 });
    expect(r.rows.map((x) => [x.key, x.status])).toEqual([
      ['phone:0', 'correct'],
      ['price:0', 'correct'],
      ['price:1', 'possibly-wrong'],
      ['city', 'not-mentioned'],
      ['address', 'not-mentioned'],
    ]);
  });

  it('reads denar prices and Macedonian Cyrillic names', () => {
    const r = run([answer('perplexity', 'НУЛА од Скопје нуди веб-страници од 12.000 денари и одржување.')]);
    expect(r.claims.find((c) => c.kind === 'price')).toMatchObject({ status: 'correct', factKey: 'price:0' });
    expect(r.claims.find((c) => c.kind === 'city')).toMatchObject({ value: 'Скопје', status: 'correct' });
    // The Cyrillic spelling has the same skeleton as the official name, so it counts as official.
    expect(r.nameVariants).toEqual([{ name: 'НУЛА', count: 1, engines: ['perplexity'], kind: 'official' }]);
  });

  it('flags a wrong phone, city and address, but does not count a city that only echoes the prompt', () => {
    const text = 'NULA is a studio based in Bitola. Address: ul. Partizanska 5. Call 02 3123 456. It works in Skopje too.';
    const r = run([answer('openai', text)]);
    const byKind = Object.fromEntries(r.claims.map((c) => [c.kind, c]));
    expect(byKind.city).toMatchObject({ value: 'Bitola', status: 'possibly-wrong' });
    expect(byKind.address).toMatchObject({ status: 'possibly-wrong', factKey: 'address' });
    expect(byKind.phone).toMatchObject({ value: '02 3123 456', status: 'possibly-wrong', factKey: 'phone:0' });
    expect(r.claims.filter((c) => c.kind === 'city')).toHaveLength(1);
  });

  it('recognises the right address', () => {
    const r = run([answer('openai', 'NULA, Адреса: ул. Македонија 12, Скопје.')]);
    expect(r.claims.find((c) => c.kind === 'address')).toMatchObject({ status: 'correct' });
  });

  it('skips answers that do not name the business and failed calls', () => {
    const r = run([answer('openai', 'Studio Lumen, from €900.'), answer('gemini', '', false)]);
    expect(r.answersChecked).toBe(0);
    expect(r.claims).toEqual([]);
    expect(r.accuracy.score).toBeNull();
  });

  it('without known facts, lists what AI said as unverified', () => {
    const r = run([answer('openai', CHATGPT_EN)], null);
    expect(r.claims.map((c) => c.status)).toEqual(['unverified', 'unverified']);
    expect(r.rows).toEqual([]);
    expect(r.accuracy).toEqual({ correct: 0, wrong: 0, score: null });
    expect(hasKnownFacts(null)).toBe(false);
    expect(hasKnownFacts(FACTS)).toBe(true);
  });

  it('builds snippets with the claim and the brand highlighted', () => {
    const r = run([answer('gemini', GEMINI_EN)]);
    const s = r.claims[0]!.snippet;
    const marked = s.highlights.map((h) => [h.kind, s.text.slice(h.start, h.end)]);
    expect(marked).toEqual([
      ['brand', 'NULA'],
      ['claim', '€300-400/month'],
    ]);
    expect(s.text).not.toContain('**');
  });

  it('reports prices that match nothing on the list in their own row', () => {
    const facts = { ...FACTS, prices: [...FACTS.prices, { label: 'Online store', amount: 590, currency: 'EUR' as const, perMonth: false }] };
    const r = run([answer('openai', 'NULA can also build a custom portal for about €2,500.')], facts);
    expect(r.rows.find((x) => x.key === 'price:other')).toMatchObject({ status: 'possibly-wrong', wrong: 1 });
  });
});

describe('name variants and formatting', () => {
  it('takes the bold name, or the name plus following capitalised words, but not the city', () => {
    const t1 = '1. **NULA Digital Agency** – x';
    expect(variantAt(t1, findSpans(t1, 'NULA')[0]!, 'Skopje')).toBe('NULA Digital Agency');
    const t2 = 'Try NULA Studio for this.';
    expect(variantAt(t2, findSpans(t2, 'NULA')[0]!, 'Skopje')).toBe('NULA Studio');
    const t3 = 'Try NULA Skopje or others.';
    expect(variantAt(t3, findSpans(t3, 'NULA')[0]!, 'Skopje')).toBe('NULA');
    const t4 = 'NULA is great.';
    expect(variantAt(t4, findSpans(t4, 'NULA')[0]!, 'Skopje')).toBe('NULA');
  });

  it('formats known prices in both languages', () => {
    expect(formatPriceFact({ amount: 1200, currency: 'EUR', perMonth: false })).toEqual({ en: 'from €1.200', mk: 'од €1.200' });
    expect(formatPriceFact({ amount: 9000, currency: 'MKD', perMonth: true })).toEqual({ en: 'from 9.000 ден./month', mk: 'од 9.000 ден. месечно' });
  });
});
