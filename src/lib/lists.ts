import type { ListItem } from './types.ts';

const ORDERED_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*(\d{1,2})\s*[.)](?:\*\*|__)?\s+(.+)$/;
const BULLET_RE = /^(\s*)[-*•–]\s+(.+)$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cleanItem(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  // "**1. Name** – ..." leaves an orphan "**" after the number is stripped.
  if ((t.match(/\*\*/g) ?? []).length % 2 === 1) t = t.replace('**', '');
  return t;
}

/**
 * Extracts ranked lists from an answer.
 *
 * - Numbered items ("1.", "2)", "### 3. Name", "**4.** Name") form lists; numbering that
 *   restarts at 1 starts a new list.
 * - If there are no numbered items, top-level bullets form one list (nested bullets are ignored).
 * - If there are neither, the body rows of the first markdown table form a list.
 *
 * Positions are 1-based and follow the order in the text, not the printed number,
 * so "1, 2, 2, 4" style mistakes do not shift the rank.
 */
export function extractLists(text: string): ListItem[][] {
  const lines = text.split(/\r?\n/);

  const ordered: ListItem[][] = [];
  let current: ListItem[] | null = null;
  for (const line of lines) {
    const m = ORDERED_RE.exec(line);
    if (!m) continue;
    const printed = Number(m[1]);
    if (current === null || printed === 1) {
      current = [];
      ordered.push(current);
    }
    current.push({ position: current.length + 1, text: cleanItem(m[2]!) });
  }
  if (ordered.length > 0) return ordered;

  const bullets: { indent: number; text: string }[] = [];
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (m) bullets.push({ indent: m[1]!.replace(/\t/g, '    ').length, text: cleanItem(m[2]!) });
  }
  if (bullets.length > 0) {
    const top = Math.min(...bullets.map((b) => b.indent));
    return [
      bullets
        .filter((b) => b.indent === top)
        .map((b, i) => ({ position: i + 1, text: b.text })),
    ];
  }

  const rows: string[] = [];
  let sawSeparator = false;
  for (const line of lines) {
    if (TABLE_SEPARATOR_RE.test(line) && line.includes('-')) {
      sawSeparator = true;
      continue;
    }
    const m = TABLE_ROW_RE.exec(line);
    if (m && sawSeparator) rows.push(cleanItem(m[1]!.split('|').join(' | ')));
    else if (!m && sawSeparator && rows.length > 0) break;
  }
  if (rows.length > 0) return [rows.map((text, i) => ({ position: i + 1, text }))];

  return [];
}

/**
 * The "name" part of a list item: bold text if present, otherwise the text before the
 * first separator (" – ", " - ", ": ", " | "). Used so that a business mentioned only in
 * another item's description does not get that item's rank.
 */
export function itemHead(text: string): string {
  const bold = /\*\*(.+?)\*\*|__(.+?)__/.exec(text);
  if (bold) return (bold[1] ?? bold[2] ?? '').trim();
  const link = /^\[([^\]]+)\]\([^)]*\)/.exec(text);
  if (link) return link[1]!.trim();
  return (text.split(/\s[–—-]\s|:\s|\s\|\s/)[0] ?? text).trim();
}

export interface PositionResult {
  position: number | null;
  listLength: number;
}

/**
 * Finds the rank of something in the answer's lists. Item heads are checked first across all
 * lists, then full item text. `listLength` is the length of the list it was found in, or of
 * the longest list if it was not found.
 */
export function findPosition(lists: ListItem[][], matches: (text: string) => boolean): PositionResult {
  for (const pass of [itemHead, (t: string) => t]) {
    for (const list of lists) {
      const hit = list.find((item) => matches(pass(item.text)));
      if (hit) return { position: hit.position, listLength: list.length };
    }
  }
  const longest = lists.reduce((n, l) => Math.max(n, l.length), 0);
  return { position: null, listLength: longest };
}
