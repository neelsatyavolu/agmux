export interface FuzzyResult {
  item: string;
  score: number;
}

/**
 * Simple fuzzy match scorer.
 * Returns a score > 0 if query fuzzy-matches target, 0 if no match.
 * Higher score = better match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 1;
  if (q.length > t.length) return 0;

  let score = 0;
  let qi = 0;
  let consecutiveBonus = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1 + consecutiveBonus;
      consecutiveBonus += 1;
      qi++;
      // Bonus for matching after separator
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === "\\") {
        score += 3;
      }
    } else {
      consecutiveBonus = 0;
    }
  }

  if (qi < q.length) return 0; // All query chars must match
  score += Math.max(0, 20 - t.length) * 0.1; // Bonus for shorter targets
  return score;
}

export function fuzzyFilter(
  query: string,
  items: string[],
  limit = 50,
): FuzzyResult[] {
  if (!query)
    return items.slice(0, limit).map((item) => ({ item, score: 1 }));

  const results: FuzzyResult[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, item);
    if (score > 0) results.push({ item, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
