/**
 * Local search semantics (REQ §8.1, ADR 0014), shared by every store and the UI: a message
 * matches when each term of the query is found as a word prefix, case- and accent-blind.
 * A term with several words (`foo-bar`) must match them in a row, the last as a prefix.
 *
 * Words follow SQLite FTS5's `unicode61` tokenizer as the Android store configures it
 * (`categories 'L* N* Co M*'`): letters, digits and combining marks (so Devanagari vowel signs
 * stay inside words); spaces, punctuation and symbols (emoji included) separate. This module
 * approximates those classes with code-point ranges, as Hermes cannot be relied on for
 * Unicode property escapes.
 */

export interface TextRange {
  start: number;
  end: number;
}

interface Word extends TextRange {
  folded: string;
}

/** Punctuation and symbol blocks outside ASCII (sorted, inclusive). */
const SEPARATOR_RANGES: readonly [number, number][] = [
  [0x80, 0xbf],
  [0xd7, 0xd7],
  [0xf7, 0xf7],
  [0x964, 0x965],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2190, 0x23ff],
  [0x2500, 0x27bf],
  [0x2900, 0x2bff],
  [0x2e00, 0x2e7f],
  [0x3000, 0x303f],
  [0xfe00, 0xfe0f],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff0f],
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff65],
  [0x1f000, 0x1faff],
  [0xe0000, 0xe007f],
];

function isWordChar(codePoint: number): boolean {
  if (codePoint < 0x80) {
    return (
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a)
    );
  }
  for (const [low, high] of SEPARATOR_RANGES) {
    if (codePoint < low) return true;
    if (codePoint <= high) return false;
  }
  return true;
}

/** Lower case without Latin accents ("Café" → "cafe"). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function words(text: string): Word[] {
  const found: Word[] = [];
  let start = -1;
  let index = 0;
  for (const char of text) {
    const word = isWordChar(char.codePointAt(0)!);
    if (word && start < 0) start = index;
    if (!word && start >= 0) {
      found.push({ start, end: index, folded: foldText(text.slice(start, index)) });
      start = -1;
    }
    index += char.length;
  }
  if (start >= 0) found.push({ start, end: index, folded: foldText(text.slice(start)) });
  return found;
}

/** The query's terms, each a run of folded words; empty when there is nothing to find. */
export function searchTerms(query: string): string[][] {
  return query
    .split(/\s+/)
    .map((term) => words(term).map((word) => word.folded))
    .filter((term) => term.length > 0);
}

/** Where `term` matches in `list`: the indexes of its words, or none. */
function termAt(list: Word[], term: string[]): number[][] {
  const hits: number[][] = [];
  for (let i = 0; i + term.length <= list.length; i++) {
    const ok = term.every((part, j) => {
      const word = list[i + j]!.folded;
      return j === term.length - 1 ? word.startsWith(part) : word === part;
    });
    if (ok) hits.push(term.map((_, j) => i + j));
  }
  return hits;
}

/** Whether `text` matches every term of `query` (and the query has one). */
export function matchesQuery(text: string, query: string): boolean {
  const terms = searchTerms(query);
  if (terms.length === 0) return false;
  const list = words(text);
  return terms.every((term) => termAt(list, term).length > 0);
}

/** The words of `text` that match a query term, in order, for highlighting. */
export function highlightRanges(text: string, query: string): TextRange[] {
  const list = words(text);
  const marked = new Set<number>();
  for (const term of searchTerms(query)) {
    for (const hit of termAt(list, term)) for (const index of hit) marked.add(index);
  }
  return [...marked]
    .sort((a, b) => a - b)
    .map((index) => ({
      start: list[index]!.start,
      end: list[index]!.end,
    }));
}

/**
 * The FTS5 `MATCH` expression for `query`: each term a quoted phrase with a prefix star, so
 * no user input is read as query syntax. Undefined when there is nothing to find.
 */
export function ftsQuery(query: string): string | undefined {
  const terms = searchTerms(query);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.join(' ').replaceAll('"', '""')}"*`).join(' ');
}
