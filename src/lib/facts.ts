/**
 * Fact accuracy check: what do AI answers say about the business, and does it match the
 * facts the owner entered?
 *
 * Heuristic by design. For every answer that names the business, the text near each mention
 * (same list item or paragraph, cut where a competitor is named) is scanned for phone numbers,
 * prices, a city and a street address. Each claim is compared with the known facts and gets
 * "correct", "possibly wrong" (verify it) or "unverified" (nothing to compare with). It never
 * claims certainty: a price near your name may belong to a sentence about someone else.
 */
import type {
  AnswerAnalysis,
  BusinessInput,
  ClaimKind,
  ClaimStatus,
  Currency,
  EngineAnswer,
  EngineId,
  FactCheck,
  FactClaim,
  FactRow,
  KnownFacts,
  Localized,
  NameVariant,
  PriceFact,
  Snippet,
  SnippetHighlight,
  StatedPrice,
} from './types.ts';
import { brandTokens, foldText, normalizeDomain } from './normalize.ts';
import { detectMention } from './mention.ts';

/** Fixed conversion used to compare denar and euro prices (the denar has been pegged near 61.5). */
export const MKD_PER_EUR = 61.5;
/** A stated price counts as correct within ±6% (at least 2 EUR) of the known price. */
export const PRICE_TOLERANCE = 0.06;

export const EMPTY_FACTS: KnownFacts = { officialName: '', nameVariants: [], phones: [], prices: [], city: '', address: '' };

export function hasKnownFacts(f: KnownFacts | null | undefined): f is KnownFacts {
  return Boolean(
    f && (f.officialName.trim() || f.nameVariants.length || f.phones.length || f.prices.length || f.city.trim() || f.address.trim()),
  );
}

// ---------- spans and windows ----------

interface Span {
  start: number;
  end: number;
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Case-insensitive literal occurrences of a needle that are not inside a longer word. */
export function findSpans(text: string, needle: string): Span[] {
  const n = needle.trim();
  if (n.length < 2) return [];
  const out: Span[] = [];
  const hay = text.toLowerCase();
  const low = n.toLowerCase();
  let i = hay.indexOf(low);
  while (i !== -1) {
    const end = i + low.length;
    if (!isWordChar(text[i - 1]) && !isWordChar(text[end])) out.push({ start: i, end });
    i = hay.indexOf(low, i + 1);
  }
  return out;
}

function allSpans(text: string, needles: string[]): Span[] {
  const spans = needles.flatMap((n) => findSpans(text, n)).sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const BOLD_LINE_RE = /^\s*(?:\d{1,2}[.)]\s*)?(?:\*\*|__)[^*_]{1,120}(?:\*\*|__)\s*:?\s*$/;
const NUMBERED_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*\d{1,2}\s*[.)]/;
const BULLET_RE = /^[-*•–]\s+/;
const TABLE_RE = /^\s*\|/;

/**
 * Splits an answer into blocks (one per list item, heading section, table row or paragraph),
 * returned as offsets into the text.
 */
export function segmentBlocks(text: string): Span[] {
  const lines: { start: number; end: number; text: string }[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    lines.push({ start: pos, end: pos + line.length, text: line });
    pos += line.length + 1;
  }
  const headerMode = lines.some((l) => HEADING_RE.test(l.text) || BOLD_LINE_RE.test(l.text));
  const numberedMode = !headerMode && lines.some((l) => NUMBERED_RE.test(l.text));
  const bulletMode = !headerMode && !numberedMode && lines.some((l) => BULLET_RE.test(l.text));

  const starts: number[] = [];
  let prevBlank = true;
  let inList = false;
  lines.forEach((l, i) => {
    const blank = l.text.trim() === '';
    let start = false;
    if (!blank) {
      if (TABLE_RE.test(l.text)) start = true;
      else if (headerMode) start = HEADING_RE.test(l.text) || BOLD_LINE_RE.test(l.text) || i === 0;
      else if (numberedMode && NUMBERED_RE.test(l.text)) start = inList = true;
      else if (bulletMode && BULLET_RE.test(l.text)) start = inList = true;
      else if (prevBlank && !/^\s/.test(l.text)) {
        // A paragraph after a blank line: a new block (and the end of any list item).
        start = !inList || !BULLET_RE.test(l.text);
        inList = false;
      }
      if (i === 0) start = true;
    }
    if (start) starts.push(i);
    prevBlank = blank;
  });
  if (starts.length === 0) return [{ start: 0, end: text.length }];
  return starts.map((lineIndex, k) => {
    const next = starts[k + 1];
    const endLine = next === undefined ? lines[lines.length - 1]! : lines[next - 1]!;
    return { start: lines[lineIndex]!.start, end: endLine.end };
  });
}

const BEFORE = 150;
const AFTER = 400;
const HEAD_BLOCK_MAX = 700;

/**
 * Text regions that talk about the business: around each mention, inside its block, and cut
 * at the nearest competitor mention on either side.
 */
export function brandWindows(text: string, brand: Span[], competitors: Span[]): Span[] {
  const blocks = segmentBlocks(text);
  const windows: Span[] = [];
  for (const m of brand) {
    const block = blocks.find((b) => m.start >= b.start && m.start < b.end) ?? { start: 0, end: text.length };
    const firstLineEnd = text.indexOf('\n', block.start);
    const inHead = m.start < (firstLineEnd === -1 ? block.end : firstLineEnd);
    let start = Math.max(block.start, m.start - BEFORE);
    let end = inHead ? Math.min(block.end, block.start + HEAD_BLOCK_MAX) : Math.min(block.end, m.end + AFTER);
    for (const c of competitors) {
      if (c.end <= m.start && c.end > start) start = c.end;
      if (c.start >= m.end && c.start < end) end = c.start;
    }
    windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

const inside = (s: Span, windows: Span[]) => windows.some((w) => s.start >= w.start && s.end <= w.end);

// ---------- money ----------

const NUM = String.raw`\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CUR_PRE = String.raw`€|\$|EUR|USD|MKD|ден\.?`;
const CUR_POST = String.raw`€|\$|EUR|[Ee]uros?|евра|евро|USD|MKD|ден(?:ари|ар)?\.?|denari|den\.?|долари|dollars?`;
const DASH = String.raw`\s?(?:-|–|—|to|до|do)\s?`;
const MONEY_PRE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(${CUR_PRE})\s?(${NUM})(?:${DASH}(?:${CUR_PRE})?\s?(${NUM}))?(\+)?`, 'gu');
const MONEY_POST_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])(${NUM})(?:${DASH}(${NUM}))?\s?(\+)?\s?(${CUR_POST})(?![\p{L}])`,
  'giu',
);

const FROM_BEFORE_RE =
  /(?:from|starting (?:at|from)|starts? at|as low as|од|почнува(?:ат)? од|почнувајќи од|веќе од|od|već od|vec od)\s*(?:around|about|approximately|околу|приближно|око)?\s*$/iu;
const MONTH_AFTER_RE =
  /^\s*(?:\+\s*)?(?:\/\s*(?:month|mo|mon|месец|мес|mesec|mjesec)(?![\p{L}])|per\s+month|a\s+month|each\s+month|monthly|месечно|на\s+месец|по\s+месец|mesečno|mesecno|mjesečno)/iu;
const MONTH_BEFORE_RE = /(?:monthly|per month|месечн\p{L}*|mesečn\p{L}*|mesecn\p{L}*)\s+(?:[\p{L}]+\s+){0,3}$/iu;

export function currencyOf(token: string): Currency {
  const t = token.toLowerCase();
  if (t === '$' || t.startsWith('usd') || t.startsWith('dollar') || t.startsWith('долар')) return 'USD';
  if (t.startsWith('mkd') || t.startsWith('ден') || t.startsWith('den')) return 'MKD';
  return 'EUR';
}

/** "12.000" -> 12000, "1,200.50" -> 1200.5, "190,5" -> 190.5. */
export function parseAmount(raw: string): number {
  const s = raw.replace(/[\u00a0\u202f ]/g, ' ').trim();
  const grouped = /^(\d{1,3})((?:[., ]\d{3})+)(?:([.,])(\d{1,2}))?$/.exec(s);
  if (grouped) {
    const whole = grouped[1]! + grouped[2]!.replace(/[., ]/g, '');
    return Number(grouped[4] ? `${whole}.${grouped[4]}` : whole);
  }
  return Number(s.replace(',', '.'));
}

export interface MoneyHit extends Span {
  raw: string;
  price: StatedPrice;
}

/** Every money amount in the text (ranges, "from", per-month and currency included). */
export function extractMoney(text: string): MoneyHit[] {
  const hits: (Span & { min: number; max: number | null; currency: Currency; plus: boolean })[] = [];
  for (const m of text.matchAll(MONEY_PRE_RE)) {
    const start = m.index ?? 0;
    hits.push({
      start,
      end: start + m[0].length,
      min: parseAmount(m[2]!),
      max: m[3] ? parseAmount(m[3]) : null,
      currency: currencyOf(m[1]!),
      plus: Boolean(m[4]),
    });
  }
  for (const m of text.matchAll(MONEY_POST_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (hits.some((h) => start < h.end && end > h.start)) continue;
    hits.push({
      start,
      end,
      min: parseAmount(m[1]!),
      max: m[2] ? parseAmount(m[2]) : null,
      currency: currencyOf(m[4]!),
      plus: Boolean(m[3]),
    });
  }
  hits.sort((a, b) => a.start - b.start);

  // "300 € – 400 €": two hits joined by a dash become one range.
  const joined: typeof hits = [];
  for (const h of hits) {
    const last = joined[joined.length - 1];
    if (
      last &&
      last.max === null &&
      last.currency === h.currency &&
      /^\s*(?:-|–|—|to|до)\s*$/i.test(text.slice(last.end, h.start))
    ) {
      last.max = h.max ?? h.min;
      last.end = h.end;
      last.plus = h.plus;
      continue;
    }
    joined.push({ ...h });
  }

  return joined
    .filter((h) => Number.isFinite(h.min) && h.min > 0 && h.min < 10_000_000)
    .map((h) => {
      const before = text.slice(Math.max(0, h.start - 40), h.start);
      const monthAfter = MONTH_AFTER_RE.exec(text.slice(h.end, h.end + 30));
      const max = h.max !== null && Number.isFinite(h.max) && h.max > h.min ? h.max : null;
      // Keep "/month" or "месечно" in the quoted value, so the claim reads as the answer wrote it.
      const end = monthAfter ? h.end + monthAfter[0].length : h.end;
      return {
        start: h.start,
        end,
        raw: text.slice(h.start, end),
        price: {
          min: h.min,
          max,
          currency: h.currency,
          perMonth: Boolean(monthAfter) || MONTH_BEFORE_RE.test(before),
          from: FROM_BEFORE_RE.test(before) || h.plus,
        },
      };
    });
}

// ---------- phones ----------

/** Digit groups joined by single spaces, dashes or slashes (a dot only between digits); never across lines. */
const PHONE_RE = /(?<![\p{L}\p{N}+])(?:\+|00)?\(?\d+\)?\d*(?:(?: ?[-–/] ?|\.(?=\d)|[ \u00a0])\(?\d+\)?\d*)*(?![\p{L}\p{N}])/gu;

/** Digits of the national significant number: "+389 73 745 473" and "073/745-473" both give 73745473. */
export function phoneKey(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('389')) return d.slice(3);
  if (d.startsWith('0')) return d.slice(1);
  return d;
}

export function samePhone(a: string, b: string): boolean {
  const x = phoneKey(a);
  const y = phoneKey(b);
  if (x.length < 6 || y.length < 6) return false;
  if (x === y) return true;
  const [long, short] = x.length >= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.endsWith(short);
}

export interface PhoneHit extends Span {
  raw: string;
}

export function extractPhones(text: string, money: Span[] = []): PhoneHit[] {
  const out: PhoneHit[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0].trim();
    const start = (m.index ?? 0) + m[0].indexOf(raw);
    const end = start + raw.length;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 13) continue;
    if (!/^(?:\+|00|0|\(0)/.test(raw)) continue;
    if (money.some((s) => start < s.end && end > s.start)) continue;
    out.push({ start, end, raw });
  }
  return out;
}

// ---------- cities and addresses ----------

/** Folded city names (Macedonian towns and nearby capitals) used to spot a wrong city. */
const CITIES = [
  'skopje', 'bitola', 'kumanovo', 'prilep', 'tetovo', 'ohrid', 'veles', 'stip', 'gostivar', 'strumica', 'kavadarci',
  'kocani', 'kicevo', 'struga', 'radovis', 'gevgelija', 'debar', 'kriva palanka', 'sveti nikole', 'negotino',
  'delcevo', 'vinica', 'resen', 'berovo', 'kratovo', 'probistip', 'demir hisar', 'valandovo', 'krusevo',
  'belgrade', 'beograd', 'sofia', 'sofija', 'tirana', 'thessaloniki', 'solun', 'pristina', 'prishtina', 'zagreb',
  'ljubljana', 'sarajevo', 'podgorica', 'vienna', 'wien', 'berlin', 'london',
];

const LOCATIVE_RE =
  /(?:based in|located in|headquartered in|offices? in|studio in|agency in|from|со седиште во|седиште во|се наоѓа во|лоцирана во|лоциран во|канцеларија во|канцеларии во|од|iz|od|sa sedištem u)\s+$/iu;

function cityKey(s: string): string {
  return foldText(s).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface CityHit extends Span {
  raw: string;
  key: string;
}

function extractCities(text: string, extra: string[]): CityHit[] {
  const names = new Set([...CITIES, ...extra.map(cityKey).filter(Boolean)]);
  const words = [...text.matchAll(/[\p{L}]+/gu)].map((m) => ({ start: m.index ?? 0, raw: m[0] }));
  const out: CityHit[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const next = words[i + 1];
    if (next && /^\s+$/.test(text.slice(w.start + w.raw.length, next.start))) {
      const key = cityKey(`${w.raw} ${next.raw}`);
      if (names.has(key)) {
        out.push({ start: w.start, end: next.start + next.raw.length, raw: text.slice(w.start, next.start + next.raw.length), key });
        i += 1;
        continue;
      }
    }
    const key = cityKey(w.raw);
    if (names.has(key)) out.push({ start: w.start, end: w.start + w.raw.length, raw: w.raw, key });
  }
  return out;
}

const STREET_RE =
  /(?:ул\.|улица|ul\.|ulica|бул\.|булевар|bul\.|bulevar|blvd\.?|street|str\.)\s*[„"“]?\p{L}[\p{L} .'’"“-]{1,40}?(?:\s?(?:бр\.|br\.|no\.)?\s?\d{1,4}[a-zа-ш]?)?(?=\s*[,;)\n]|\s*\.(?:\s|$)|$)/giu;
const ADDRESS_LABEL_RE = /(?:address|адреса|adresa)\s*:\s*[^\n;]{3,60}?(?=\s*[\n;]|\s*\)|$|\.\s*$)/giu;
const STREET_WORDS = new Set(['ul', 'ulica', 'bul', 'bulevar', 'blvd', 'street', 'str', 'br', 'broj', 'no', 'adresa', 'address']);

function streetToken(address: string): string {
  const words = foldText(address)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STREET_WORDS.has(w) && !/^\d+$/.test(w));
  return words.sort((a, b) => b.length - a.length)[0] ?? '';
}

// ---------- prices ----------

const LABEL_GROUPS: string[][] = [
  ['web', 'veb', 'website', 'site', 'sajt', 'stranic', 'one page', 'onepage', 'landing'],
  ['social', 'socijal', 'mrez', 'instagram', 'facebook', 'smm', 'tiktok'],
  ['shop', 'store', 'commerce', 'prodavnic', 'webshop', 'online prodaz'],
  ['seo', 'optimizac', 'search engine'],
  ['logo', 'brand', 'brend', 'identit', 'vizuel'],
  ['ads', 'oglas', 'kampanj', 'campaign', 'advertis', 'reklam'],
  ['hosting', 'hosting', 'maintenance', 'odrzuvan', 'odrzavan', 'support', 'poddrsk'],
  ['photo', 'foto', 'video', 'snimanj'],
];
const STOP = new Set(['from', 'the', 'and', 'for', 'per', 'month', 'paket', 'package', 'usluga', 'service']);

function labelConcepts(text: string): Set<number> {
  const f = foldText(text);
  const out = new Set<number>();
  LABEL_GROUPS.forEach((g, i) => {
    if (g.some((t) => f.includes(t))) out.add(i);
  });
  return out;
}

function labelMatches(label: string, context: string): boolean {
  const ctx = foldText(context);
  const concepts = labelConcepts(label);
  const ctxConcepts = labelConcepts(context);
  if ([...concepts].some((c) => ctxConcepts.has(c))) return true;
  const stems = foldText(label)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w))
    .map((w) => w.slice(0, 5));
  return stems.some((s) => new RegExp(`(?:^|[^a-z0-9])${s}`).test(ctx));
}

function toEur(amount: number, currency: Currency): number | null {
  if (currency === 'EUR') return amount;
  if (currency === 'MKD') return amount / MKD_PER_EUR;
  return null;
}

function comparable(a: Currency, b: Currency): boolean {
  return a === b || (a !== 'USD' && b !== 'USD');
}

function amountMatches(stated: StatedPrice, fact: PriceFact): boolean {
  if (stated.currency === fact.currency) {
    return Math.abs(stated.min - fact.amount) <= Math.max(fact.currency === 'MKD' ? 120 : 2, fact.amount * PRICE_TOLERANCE);
  }
  const s = toEur(stated.min, stated.currency);
  const f = toEur(fact.amount, fact.currency);
  if (s === null || f === null) return false;
  return Math.abs(s - f) <= Math.max(2, f * PRICE_TOLERANCE);
}

export function comparePrice(
  stated: StatedPrice,
  prices: PriceFact[],
  context: string,
): { status: ClaimStatus; factIndex: number | null } {
  const candidates = prices
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.perMonth === stated.perMonth && comparable(p.currency, stated.currency));
  if (candidates.length === 0) return { status: 'unverified', factIndex: null };
  const labelled = candidates.filter(({ p }) => p.label.trim() && labelMatches(p.label, context));
  const pool = labelled.length > 0 ? labelled : candidates;
  const hit = pool.find(({ p }) => amountMatches(stated, p));
  if (hit) return { status: 'correct', factIndex: hit.i };
  if (labelled.length > 0 || candidates.length === 1) return { status: 'possibly-wrong', factIndex: pool[0]!.i };
  return { status: 'possibly-wrong', factIndex: null };
}

const SYMBOL: Record<Currency, string> = { EUR: '€', MKD: 'ден.', USD: '$' };

function money(amount: number, currency: Currency): string {
  const n = Number.isInteger(amount) ? amount.toLocaleString('en-US').replace(/,/g, '.') : String(amount);
  return currency === 'MKD' ? `${n} ${SYMBOL.MKD}` : currency === 'USD' ? `$${n}` : `€${n}`;
}

/** "from €150/month" / "од €150 месечно". */
export function formatPriceFact(p: Pick<PriceFact, 'amount' | 'currency' | 'perMonth'>): Localized {
  const m = money(p.amount, p.currency);
  return { en: `from ${m}${p.perMonth ? '/month' : ''}`, mk: `од ${m}${p.perMonth ? ' месечно' : ''}` };
}

// ---------- names ----------

const NAME_STOP = new Set(['the', 'and', 'is', 'in', 'a', 'an', 'for', 'of', 'i', 'е', 'и', 'во', 'за', 'од', 'со']);

function nameKey(name: string): string {
  return brandTokens(name)
    .map((t) => t.key)
    .join('');
}

/** The full name the answer used around a mention: bold/link text, or the name plus following capitalised words. */
export function variantAt(text: string, span: Span, city: string): string {
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const lineEndRaw = text.indexOf('\n', span.end);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const rel = span.start - lineStart;

  for (const re of [/\*\*([^*\n]{1,80})\*\*/g, /__([^_\n]{1,80})__/g, /\[([^\]\n]{1,80})\]\(/g]) {
    for (const m of line.matchAll(re)) {
      const s = (m.index ?? 0) + 2;
      const inner = m[1]!;
      if (rel >= s - 1 && rel < s + inner.length) {
        const cleaned = inner.replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/[:–—-]\s*$/, '').trim();
        if (cleaned.split(/\s+/).length <= 6) return cleaned;
      }
    }
  }

  const cityK = cityKey(city);
  let end = span.end;
  let taken = 0;
  const re = /^[ ]((?:[\p{Lu}][\p{L}'’.-]*|&|[\p{Lu}\d]{2,}))/u;
  while (taken < 3) {
    const m = re.exec(text.slice(end, end + 40));
    if (!m) break;
    const word = m[1]!;
    const k = cityKey(word);
    if (NAME_STOP.has(word.toLowerCase()) || (cityK && k === cityK) || CITIES.includes(k)) break;
    end += m[0].length;
    taken += 1;
  }
  return text.slice(span.start, end).replace(/[.’']+$/, '').trim();
}

// ---------- snippets ----------

function cleanSnippetText(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeSnippet(text: string, claim: Span, claimRaw: string, brandNeedles: string[]): Snippet {
  let start = Math.max(0, claim.start - 100);
  // Pull the start back to the nearest brand mention before the claim, so the snippet shows who it is about.
  const before = allSpans(text, brandNeedles).filter((b) => b.end <= claim.start && claim.start - b.start <= 240);
  const nearest = before[before.length - 1];
  if (nearest && nearest.start < start) start = nearest.start;
  let end = Math.min(text.length, claim.end + 90);
  if (start > 0 && start !== nearest?.start) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < claim.start) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > claim.end) end = sp;
  }
  const body = cleanSnippetText(text.slice(start, end));
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const out = `${prefix}${body}${suffix}`;
  const highlights: SnippetHighlight[] = [];
  const claimText = cleanSnippetText(claimRaw);
  const ci = out.indexOf(claimText);
  if (ci !== -1) highlights.push({ start: ci, end: ci + claimText.length, kind: 'claim' });
  for (const n of [...brandNeedles].sort((a, b) => b.length - a.length)) {
    for (const s of findSpans(out, n)) {
      if (highlights.some((h) => s.start < h.end && s.end > h.start)) continue;
      highlights.push({ start: s.start, end: s.end, kind: 'brand' });
    }
  }
  highlights.sort((a, b) => a.start - b.start);
  return { text: out, highlights };
}

// ---------- main ----------

export interface FactCheckInput {
  business: BusinessInput;
  facts: KnownFacts | null;
  answers: EngineAnswer[];
  analyses: AnswerAnalysis[];
}

function lineAround(text: string, s: Span): string {
  const a = text.lastIndexOf('\n', s.start - 1) + 1;
  const b = text.indexOf('\n', s.end);
  return text.slice(Math.max(a, s.start - 120), b === -1 ? Math.min(text.length, s.end + 60) : Math.min(b, s.end + 60));
}

export function checkFacts(input: FactCheckInput): FactCheck {
  const { business } = input;
  const facts = input.facts ?? EMPTY_FACTS;
  const official = facts.officialName.trim() || business.name.trim();
  const allowed = [...new Set([...business.aliases, ...facts.nameVariants].map((s) => s.trim()).filter(Boolean))];
  const officialKey = nameKey(official);
  const allowedKeys = new Set([nameKey(business.name), ...allowed.map(nameKey)].filter((k) => k && k !== officialKey));
  const city = facts.city.trim() || business.city.trim();
  const knownStreet = streetToken(facts.address);
  const domain = normalizeDomain(business.domain);

  const claims: FactClaim[] = [];
  const variantCounts = new Map<string, { name: string; count: number; engines: Set<EngineId>; kind: NameVariant['kind'] }>();
  let answersChecked = 0;

  input.analyses.forEach((analysis, i) => {
    const answer = input.answers[i];
    if (!answer || !answer.ok || !analysis.mentioned) return;
    answersChecked += 1;
    const text = answer.text;

    const nameNeedles = [analysis.matchedText ?? '', business.name, official, ...allowed].filter(
      (n) => n.trim().length > 1 && !(domain && n.toLowerCase().includes(domain)),
    );
    const brand = allSpans(text, [...nameNeedles, domain].filter(Boolean));
    if (brand.length === 0) return;
    const competitorNeedles = business.competitors.flatMap((c) => {
      const m = detectMention(text, { name: c });
      return [c, m.matchedText ?? ''].filter(Boolean);
    });
    const windows = brandWindows(text, brand, allSpans(text, competitorNeedles));
    const seen = new Set<string>();
    const add = (kind: ClaimKind, span: Span, raw: string, dedupe: string, status: ClaimStatus, factKey: string | null, price?: StatedPrice) => {
      const key = `${kind}:${dedupe}`;
      if (seen.has(key)) return;
      seen.add(key);
      claims.push({
        kind,
        engine: answer.engine,
        prompt: answer.prompt,
        value: raw,
        status,
        factKey,
        ...(price ? { price } : {}),
        snippet: makeSnippet(text, span, raw, nameNeedles),
      });
    };

    const moneyHits = extractMoney(text);
    for (const h of moneyHits) {
      if (!inside(h, windows)) continue;
      const cmp = facts.prices.length > 0 ? comparePrice(h.price, facts.prices, lineAround(text, h)) : { status: 'unverified' as const, factIndex: null };
      add('price', h, h.raw, `${h.price.min}-${h.price.max}-${h.price.currency}-${h.price.perMonth}`, cmp.status, cmp.factIndex === null ? null : `price:${cmp.factIndex}`, h.price);
    }

    for (const p of extractPhones(text, moneyHits)) {
      if (!inside(p, windows)) continue;
      const idx = facts.phones.findIndex((k) => samePhone(k, p.raw));
      const status: ClaimStatus = facts.phones.length === 0 ? 'unverified' : idx >= 0 ? 'correct' : 'possibly-wrong';
      add('phone', p, p.raw, phoneKey(p.raw), status, idx >= 0 ? `phone:${idx}` : facts.phones.length === 1 ? 'phone:0' : null);
    }

    if (city) {
      const ck = cityKey(city);
      for (const c of extractCities(text, [city])) {
        if (!inside(c, windows) || !LOCATIVE_RE.test(text.slice(Math.max(0, c.start - 40), c.start))) continue;
        add('city', c, c.raw, c.key, c.key === ck ? 'correct' : 'possibly-wrong', 'city');
      }
    }

    const streets = [...text.matchAll(STREET_RE)];
    const labels = [...text.matchAll(ADDRESS_LABEL_RE)].filter(
      (l) => !streets.some((m) => (m.index ?? 0) >= (l.index ?? 0) && (m.index ?? 0) < (l.index ?? 0) + l[0].length),
    );
    for (const m of [...streets, ...labels]) {
      const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
      if (!inside(span, windows)) continue;
      const raw = m[0].trim();
      const status: ClaimStatus = !knownStreet ? 'unverified' : foldText(raw).includes(knownStreet) ? 'correct' : 'possibly-wrong';
      add('address', span, raw, foldText(raw), status, knownStreet ? 'address' : null);
    }

    // Name variants used in this answer (once per variant per answer).
    const used = new Set<string>();
    for (const s of allSpans(text, nameNeedles)) {
      const name = variantAt(text, s, city);
      const key = nameKey(name);
      if (!key || used.has(key)) continue;
      used.add(key);
      const kind: NameVariant['kind'] = key === officialKey ? 'official' : allowedKeys.has(key) ? 'allowed' : 'other';
      const entry = variantCounts.get(key) ?? { name, count: 0, engines: new Set<EngineId>(), kind };
      entry.count += 1;
      entry.engines.add(answer.engine);
      variantCounts.set(key, entry);
    }
  });

  const rows = buildRows(facts, city, claims);
  const correct = claims.filter((c) => c.status === 'correct').length;
  const wrong = claims.filter((c) => c.status === 'possibly-wrong').length;
  const nameVariants: NameVariant[] = [...variantCounts.values()]
    .map((v) => ({ name: v.name, count: v.count, engines: [...v.engines], kind: v.kind }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    answersChecked,
    claims,
    rows,
    nameVariants,
    accuracy: { correct, wrong, score: correct + wrong === 0 ? null : Math.round((100 * correct) / (correct + wrong)) },
  };
}

function buildRows(facts: KnownFacts, city: string, claims: FactClaim[]): FactRow[] {
  const rows: FactRow[] = [];
  const row = (key: string, kind: ClaimKind, label: Localized, expected: Localized, matches: (c: FactClaim) => boolean) => {
    const related = claims.filter(matches);
    const correct = related.filter((c) => c.status === 'correct').length;
    const wrong = related.filter((c) => c.status === 'possibly-wrong').length;
    rows.push({
      key,
      kind,
      label,
      expected,
      status: wrong > 0 ? 'possibly-wrong' : correct > 0 ? 'correct' : 'not-mentioned',
      correct,
      wrong,
      engines: [...new Set(related.map((c) => c.engine))],
    });
  };

  facts.phones.forEach((p, i) => {
    row(`phone:${i}`, 'phone', { en: 'Phone', mk: 'Телефон' }, { en: p, mk: p }, (c) =>
      c.kind === 'phone' && (c.factKey === `phone:${i}` || (c.status === 'possibly-wrong' && facts.phones.length === 1)),
    );
  });
  const unmatchedPhones = claims.filter((c) => c.kind === 'phone' && c.status === 'possibly-wrong' && c.factKey === null);
  if (facts.phones.length > 1 && unmatchedPhones.length > 0) {
    // A number that matches none of several known phones is reported against the first one.
    const first = rows.find((r) => r.key === 'phone:0');
    if (first) {
      first.wrong += unmatchedPhones.length;
      first.status = 'possibly-wrong';
      first.engines = [...new Set([...first.engines, ...unmatchedPhones.map((c) => c.engine)])];
    }
  }

  facts.prices.forEach((p, i) => {
    const label = p.label.trim() || (p.perMonth ? 'Monthly price' : 'Price');
    row(`price:${i}`, 'price', { en: label, mk: p.label.trim() || (p.perMonth ? 'Месечна цена' : 'Цена') }, formatPriceFact(p), (c) =>
      c.kind === 'price' && c.factKey === `price:${i}`,
    );
  });
  const orphanPrices = claims.filter((c) => c.kind === 'price' && c.status === 'possibly-wrong' && c.factKey === null);
  if (orphanPrices.length > 0) {
    rows.push({
      key: 'price:other',
      kind: 'price',
      label: { en: 'Prices not on your list', mk: 'Цени што ги нема во вашиот ценовник' },
      expected: {
        en: facts.prices.map((p) => `${p.label} ${formatPriceFact(p).en}`).join('; '),
        mk: facts.prices.map((p) => `${p.label} ${formatPriceFact(p).mk}`).join('; '),
      },
      status: 'possibly-wrong',
      correct: 0,
      wrong: orphanPrices.length,
      engines: [...new Set(orphanPrices.map((c) => c.engine))],
    });
  }

  if (facts.city.trim()) {
    row('city', 'city', { en: 'City', mk: 'Град' }, { en: city, mk: city }, (c) => c.kind === 'city');
  }
  if (facts.address.trim()) {
    row('address', 'address', { en: 'Address', mk: 'Адреса' }, { en: facts.address, mk: facts.address }, (c) => c.kind === 'address' && c.factKey === 'address');
  }
  return rows;
}

/** Short bilingual sentence for one wrong claim, used as evidence in recommendations. */
export function describeWrongClaim(claim: FactClaim, facts: KnownFacts, engineLabel: string): Localized {
  const idx = claim.factKey?.startsWith('price:') ? Number(claim.factKey.slice(6)) : NaN;
  const fact = Number.isInteger(idx) ? facts.prices[idx] : undefined;
  if (claim.kind === 'price' && fact) {
    const f = formatPriceFact(fact);
    return {
      en: `${engineLabel} stated ${claim.value}; your price${fact.label ? ` for ${fact.label}` : ''} is ${f.en}.`,
      mk: `${engineLabel} наведе ${claim.value}; вашата цена${fact.label ? ` за ${fact.label}` : ''} е ${f.mk}.`,
    };
  }
  if (claim.kind === 'price') {
    return {
      en: `${engineLabel} stated ${claim.value}, which matches none of your listed prices.`,
      mk: `${engineLabel} наведе ${claim.value}, а таква цена ја нема во вашиот ценовник.`,
    };
  }
  if (claim.kind === 'phone') {
    const known = facts.phones.join(', ');
    return {
      en: `${engineLabel} gave the phone number ${claim.value}; yours is ${known}.`,
      mk: `${engineLabel} го наведе бројот ${claim.value}; вашиот е ${known}.`,
    };
  }
  if (claim.kind === 'city') {
    return {
      en: `${engineLabel} placed you in ${claim.value}; you are in ${facts.city}.`,
      mk: `${engineLabel} ве смести во ${claim.value}; вие сте во ${facts.city}.`,
    };
  }
  return {
    en: `${engineLabel} gave the address "${claim.value}"; yours is ${facts.address}.`,
    mk: `${engineLabel} ја наведе адресата „${claim.value}“; вашата е ${facts.address}.`,
  };
}
