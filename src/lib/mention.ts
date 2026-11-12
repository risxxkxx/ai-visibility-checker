import type { MatchType, MentionResult } from './types.ts';
import {
  brandTokens,
  fuzzyTolerance,
  hostMatchesDomain,
  levenshtein,
  normalizeDomain,
  tokenize,
  type Token,
} from './normalize.ts';

const RANK: Record<MatchType, number> = { exact: 4, normalized: 3, fuzzy: 2, domain: 1 };

const NONE: MentionResult = { mentioned: false, matchType: null, matchedText: null };

function better(a: MentionResult, b: MentionResult): MentionResult {
  if (!b.mentioned) return a;
  if (!a.mentioned) return b;
  return RANK[b.matchType!] > RANK[a.matchType!] ? b : a;
}

function span(text: string, tokens: Token[], from: number, to: number): string {
  return text.slice(tokens[from]!.start, tokens[to]!.end);
}

/** Finds one name (brand or alias) in pre-tokenised text. */
function matchName(text: string, textTokens: Token[], name: string): MentionResult {
  const brand = brandTokens(name);
  if (brand.length === 0) return NONE;

  const brandRaw = brand.map((t) => t.raw);
  const brandKeys = brand.map((t) => t.key);
  const brandCompact = brandKeys.join('');
  const tolerance = fuzzyTolerance(brandCompact.length);
  let best: MentionResult = NONE;

  // Window sizes: the brand's own token count, plus one either side to catch
  // "ExampleStudio" vs "Example Studio" and split/joined spellings.
  const sizes = new Set([brand.length, Math.max(1, brand.length - 1), brand.length + 1]);

  for (let i = 0; i < textTokens.length; i += 1) {
    for (const size of sizes) {
      const j = i + size - 1;
      if (j >= textTokens.length) continue;
      const window = textTokens.slice(i, j + 1);

      if (size === brand.length && window.every((t, k) => t.raw === brandRaw[k])) {
        return { mentioned: true, matchType: 'exact', matchedText: span(text, textTokens, i, j) };
      }

      if (size === brand.length && window.every((t, k) => t.key === brandKeys[k])) {
        best = better(best, { mentioned: true, matchType: 'normalized', matchedText: span(text, textTokens, i, j) });
        continue;
      }

      const compact = window.map((t) => t.key).join('');
      if (compact === brandCompact) {
        best = better(best, { mentioned: true, matchType: 'normalized', matchedText: span(text, textTokens, i, j) });
        continue;
      }

      if (
        tolerance > 0 &&
        best.matchType !== 'normalized' &&
        compact[0] === brandCompact[0] &&
        levenshtein(compact, brandCompact, tolerance) <= tolerance
      ) {
        best = better(best, { mentioned: true, matchType: 'fuzzy', matchedText: span(text, textTokens, i, j) });
      }
    }
  }
  return best;
}

const HOST_RE = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi;

/** Finds the business's domain written anywhere in the text. */
export function findDomain(text: string, domain: string): string | null {
  const d = normalizeDomain(domain);
  if (!d) return null;
  for (const m of text.matchAll(HOST_RE)) {
    const host = m[1]!.toLowerCase();
    if (hostMatchesDomain(host, d)) return m[0];
  }
  return null;
}

export interface MentionTarget {
  name: string;
  aliases?: string[];
  domain?: string;
}

/**
 * Detects whether a business is mentioned in an answer.
 * Order of strength: exact name, normalised name (case, diacritics, Cyrillic/Latin,
 * joined/split words), fuzzy name (1-2 typos for longer names), then the domain alone.
 */
export function detectMention(text: string, target: MentionTarget): MentionResult {
  if (!text) return NONE;
  const tokens = tokenize(text);
  let best: MentionResult = NONE;
  for (const name of [target.name, ...(target.aliases ?? [])]) {
    if (!name.trim()) continue;
    best = better(best, matchName(text, tokens, name));
    if (best.matchType === 'exact') return best;
  }
  if (best.mentioned) return best;
  if (target.domain) {
    const hit = findDomain(text, target.domain);
    if (hit) return { mentioned: true, matchType: 'domain', matchedText: hit };
  }
  return NONE;
}

/** Convenience boolean form. */
export function mentions(text: string, target: MentionTarget): boolean {
  return detectMention(text, target).mentioned;
}
