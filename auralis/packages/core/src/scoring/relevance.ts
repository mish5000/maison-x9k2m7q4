import { comparisonKey } from '../query/normalize.js';

/** Text similarity helpers used by ranking and deduplication. */

export function tokenize(text: string): readonly string[] {
  const key = comparisonKey(text);
  return key.length === 0 ? [] : key.split(' ').filter((token) => token.length > 0);
}

/** Jaccard similarity over token sets. Cheap, order-independent, explainable. */
export function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/** Fraction of query tokens present in the candidate text. */
export function coverage(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const candidateTokens = new Set(tokenize(candidate));
  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

/**
 * Normalised Levenshtein similarity, bounded so long strings cannot make this
 * expensive. Used only for short fields such as titles.
 */
export function editSimilarity(a: string, b: string, maxLength = 96): number {
  const left = comparisonKey(a).slice(0, maxLength);
  const right = comparisonKey(b).slice(0, maxLength);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;

  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  const distance = previous[right.length] ?? Math.max(left.length, right.length);
  return 1 - distance / Math.max(left.length, right.length);
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  const key = comparisonKey(haystack);
  const needle = comparisonKey(phrase);
  return needle.length > 0 && key.includes(needle);
}

export function isExactTitleMatch(query: string, title: string): boolean {
  return comparisonKey(query) === comparisonKey(title);
}
