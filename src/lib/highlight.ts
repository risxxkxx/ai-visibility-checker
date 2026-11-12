import type { AnswerAnalysis, BusinessInput } from './types.ts';
import { detectMention } from './mention.ts';

export type SegmentKind = 'you' | 'competitor';

export interface Segment {
  text: string;
  kind: SegmentKind | null;
}

export interface Needle {
  text: string;
  kind: SegmentKind;
}

/** Light clean-up so markdown answers read well as plain text. */
export function plainAnswer(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits text into plain and highlighted segments. Longer needles win over shorter ones and
 * matches never overlap. Matching is case-insensitive and literal.
 */
export function highlight(text: string, needles: Needle[]): Segment[] {
  const usable = needles.filter((n) => n.text.trim().length > 1).sort((a, b) => b.text.length - a.text.length);
  if (usable.length === 0 || !text) return [{ text, kind: null }];

  const ranges: { start: number; end: number; kind: SegmentKind }[] = [];
  for (const n of usable) {
    const re = new RegExp(escapeRe(n.text), 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (ranges.some((r) => start < r.end && end > r.start)) continue;
      ranges.push({ start, end, kind: n.kind });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), kind: null });
    out.push({ text: text.slice(r.start, r.end), kind: r.kind });
    cursor = r.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), kind: null });
  return out;
}

/** Highlight targets for one answer: the business (and how it was matched) plus named competitors. */
export function answerNeedles(business: BusinessInput, analysis: AnswerAnalysis, text: string): Needle[] {
  const needles: Needle[] = [];
  if (analysis.matchedText) needles.push({ text: analysis.matchedText, kind: 'you' });
  needles.push({ text: business.name, kind: 'you' });
  for (const alias of business.aliases) needles.push({ text: alias, kind: 'you' });
  for (const c of analysis.competitors) {
    const m = detectMention(text, { name: c.name });
    if (m.matchedText) needles.push({ text: m.matchedText, kind: 'competitor' });
    needles.push({ text: c.name, kind: 'competitor' });
  }
  return needles;
}
