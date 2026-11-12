/**
 * Text normalisation for brand matching across scripts.
 *
 * The goal is a lossy "skeleton" that is the same for the ways people actually write a
 * Macedonian business name: Cyrillic (Шарена Ќеса), Latin with diacritics (Šarena Ḱesa),
 * and the informal Latin people type (Sharena Kjesa / Sarena Kesa). Both the brand and
 * the answer text go through the same function, so the comparison is symmetric.
 */

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'g', е: 'e', ж: 'z', з: 'z', ѕ: 'dz',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', ќ: 'k', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz',
  ш: 's',
  // Serbian, Bulgarian and Russian letters that show up in regional answers.
  ђ: 'dj', ћ: 'c', й: 'j', ы: 'y', э: 'e', ю: 'ju', я: 'ja', щ: 'sc', ъ: '', ь: '',
  ё: 'e', є: 'e', і: 'i', ї: 'i',
};

const LATIN_SPECIAL: Record<string, string> = {
  đ: 'dj', ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', ł: 'l', ı: 'i', þ: 'th',
};

/** Macedonian Cyrillic to a readable Latin form (ASCII only). */
export function transliterate(input: string): string {
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC_TO_LATIN[lower];
    if (mapped === undefined) {
      out += ch;
    } else if (ch !== lower && mapped.length > 0) {
      out += mapped[0]!.toUpperCase() + mapped.slice(1);
    } else {
      out += mapped;
    }
  }
  return out;
}

/** Lowercase, strip diacritics, transliterate Cyrillic. Keeps spacing and punctuation. */
export function foldText(input: string): string {
  const lower = transliterate(input.toLowerCase());
  let out = '';
  for (const ch of lower.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) continue;
    out += LATIN_SPECIAL[ch] ?? ch;
  }
  return out;
}

/**
 * Collapses the digraphs that informal Latin uses for Macedonian letters
 * (sh, ch, zh, gj, kj, dzh) so "Sharena" and "Šarena" end up identical.
 */
function collapseDigraphs(word: string): string {
  return word
    .replace(/dzh/g, 'dz')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'c')
    .replace(/zh/g, 'z')
    .replace(/gj/g, 'g')
    .replace(/kj/g, 'k');
}

/** Skeleton of a single word: folded, ASCII letters and digits only, digraphs collapsed. */
export function skeletonWord(word: string): string {
  const folded = foldText(word).replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  return collapseDigraphs(folded);
}

export interface Token {
  /** Skeleton form used for comparison. */
  key: string;
  /** Original text of the token. */
  raw: string;
  start: number;
  end: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*|&/gu;

/** Splits text into word tokens, keeping offsets into the original string. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0];
    const key = skeletonWord(raw.replace(/['’]s$/i, '').replace(/['’]/g, ''));
    if (!key) continue;
    const start = m.index ?? 0;
    tokens.push({ key, raw, start, end: start + raw.length });
  }
  return tokens;
}

/** Legal-form suffixes that people drop when they talk about a business. */
const LEGAL_SUFFIXES = new Set([
  'dooel', 'doo', 'dool', 'ad', 'llc', 'ltd', 'inc', 'gmbh', 'bv', 'sa', 'ag', 'plc', 'srl', 'oy', 'ab',
]);

/**
 * Brand tokens with legal-form suffixes removed ("Example Studio DOOEL" -> example studio).
 * Dotted forms such as "D.O.O.E.L." are handled by joining trailing single letters first.
 */
export function brandTokens(name: string): Token[] {
  const tokens = tokenize(name);
  // Merge a trailing run of single-letter tokens (d.o.o.e.l.) into one token.
  let i = tokens.length;
  while (i > 0 && tokens[i - 1]!.key.length === 1) i -= 1;
  if (tokens.length - i >= 2) {
    const run = tokens.slice(i);
    const merged: Token = {
      key: run.map((t) => t.key).join(''),
      raw: run.map((t) => t.raw).join('.'),
      start: run[0]!.start,
      end: run[run.length - 1]!.end,
    };
    tokens.splice(i, run.length, merged);
  }
  const stripped = [...tokens];
  while (stripped.length > 1 && LEGAL_SUFFIXES.has(stripped[stripped.length - 1]!.key)) stripped.pop();
  while (stripped.length > 1 && LEGAL_SUFFIXES.has(stripped[0]!.key)) stripped.shift();
  return stripped;
}

/** Classic Levenshtein distance with an early exit once the distance exceeds `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

/** How many typos we tolerate for a name of this (skeleton) length. */
export function fuzzyTolerance(length: number): number {
  if (length >= 12) return 2;
  if (length >= 6) return 1;
  return 0;
}

/** "https://www.Example.mk/contact" -> "example.mk". Returns '' for unusable input. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split(/[/?#]/)[0] ?? '';
  d = d.split('@').pop() ?? '';
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : '';
}

/** Hostname of a URL without "www.", or null if it is not a URL. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
