import type { BusinessInput, Language } from './types.ts';

export const DEFAULT_PROMPT_COUNT = 8;
export const MIN_PROMPT_COUNT = 1;
export const MAX_PROMPT_COUNT = 15;

/**
 * Buyer-style prompt templates, ordered by how often real customers phrase things this way.
 * The generator takes them in order, so the first N are always the same for the same input.
 *
 * Placeholders: {category} {city} {country} {competitor}
 * Templates that use {competitor} are only used when at least one competitor is given.
 */
export const PROMPT_TEMPLATES: Record<Language, readonly string[]> = {
  en: [
    'What is the best {category} in {city}?',
    'Can you recommend a good {category} in {city}, {country}?',
    'I run a small business in {city}. Which {category} should I hire?',
    'Top 5 {category} options in {city}',
    'Who is the most trusted {category} in {city}? I care about reviews.',
    'What are good alternatives to {competitor} in {city}?',
    'I need an affordable {category} in {city}. Who do you suggest?',
    'Which {category} in {city} has the best reputation?',
    'Compare the leading {category} companies in {city}, {country}.',
    'Who would you call first for {category} work in {city}?',
    'List reliable {category} providers near {city} with their websites.',
    'Is {competitor} the best {category} in {city}, or are there better options?',
    'Which {category} in {city} works with international clients?',
    'Recommend an experienced {category} in {country}, ideally based in {city}.',
    'Where can I find a {category} in {city} that replies quickly and delivers on time?',
  ],
  mk: [
    'Кој е најдобар за {category} во {city}?',
    'Можеш ли да ми препорачаш {category} во {city}, {country}?',
    'Имам мал бизнис во {city}. Кого да ангажирам за {category}?',
    'Топ 5 опции за {category} во {city}',
    'Кој е најдоверлив за {category} во {city}? Ми се важни рецензиите.',
    'Кои се добри алтернативи на {competitor} во {city}?',
    'Барам поволна цена за {category} во {city}. Што препорачуваш?',
    'Кој има најдобра репутација за {category} во {city}?',
    'Спореди ги водечките фирми за {category} во {city}, {country}.',
    'Кого прво би го повикал за {category} во {city}?',
    'Наведи сигурни фирми за {category} во и околу {city}, со нивните веб-страници.',
    'Дали {competitor} е најдобар за {category} во {city} или има подобри?',
    'Која фирма за {category} во {city} работи со странски клиенти?',
    'Препорачај искусна фирма за {category} во {country}, по можност од {city}.',
    'Каде да најдам {category} во {city} што брзо одговара и испорачува навреме?',
  ],
};

function fill(template: string, input: BusinessInput, competitor: string): string {
  return template
    .replaceAll('{category}', input.category.trim())
    .replaceAll('{city}', input.city.trim())
    .replaceAll('{country}', input.country.trim())
    .replaceAll('{competitor}', competitor)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,?.!])/g, '$1')
    .replace(/,\s*([?.!])/g, '$1')
    .trim();
}

export function clampPromptCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_PROMPT_COUNT;
  return Math.min(MAX_PROMPT_COUNT, Math.max(MIN_PROMPT_COUNT, Math.round(count)));
}

/**
 * Deterministically generates buyer-style prompts for a business.
 * Same input + count always gives the same prompts in the same order.
 * The business's own name is never put into a prompt: we want to see whether
 * the assistant brings it up on its own.
 */
export function generatePrompts(input: BusinessInput, count: number = DEFAULT_PROMPT_COUNT): string[] {
  const n = clampPromptCount(count);
  const competitors = input.competitors.map((c) => c.trim()).filter(Boolean);
  const templates = PROMPT_TEMPLATES[input.language] ?? PROMPT_TEMPLATES.en;
  const hasCountry = input.country.trim().length > 0;

  const out: string[] = [];
  const seen = new Set<string>();
  let competitorIndex = 0;

  for (const template of templates) {
    if (out.length >= n) break;
    let competitor = '';
    if (template.includes('{competitor}')) {
      if (competitors.length === 0) continue;
      competitor = competitors[competitorIndex % competitors.length]!;
      competitorIndex += 1;
    }
    const t = hasCountry ? template : template.replace(/,\s*\{country\}/g, '').replace(/\{country\}/g, input.city);
    const prompt = fill(t, input, competitor);
    const key = prompt.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(prompt);
    }
  }
  return out;
}

/** Cleans a user-edited prompt list: trims, drops empties and duplicates, caps the count. */
export function sanitizePromptList(prompts: string[], maxLength = 300): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompts) {
    const p = raw.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_PROMPT_COUNT) break;
  }
  return out;
}
