export interface DiffLine {
  type: "context" | "removed" | "added";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

function simpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const removed: DiffLine[] = oldLines.map((content, i) => ({
    type: "removed",
    content,
    oldLineNo: i + 1,
    newLineNo: null,
  }));
  const added: DiffLine[] = newLines.map((content, j) => ({
    type: "added",
    content,
    oldLineNo: null,
    newLineNo: j + 1,
  }));
  return [...removed, ...added];
}

export function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > 500_000) {
    return simpleDiff(oldLines, newLines);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const stack: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "context", content: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "added", content: newLines[j - 1], oldLineNo: null, newLineNo: j });
      j--;
    } else {
      stack.push({ type: "removed", content: oldLines[i - 1], oldLineNo: i, newLineNo: null });
      i--;
    }
  }

  return stack.reverse();
}

function hashKey(oldStr: string, newStr: string): string {
  let h = 5381;
  const combined = `${oldStr.length}:${newStr.length}:${oldStr}|${newStr}`;
  for (let k = 0; k < combined.length; k++) {
    h = ((h << 5) + h) ^ combined.charCodeAt(k);
    h = h >>> 0;
  }
  return h.toString(36);
}

interface CacheEntry {
  oldStr: string;
  newStr: string;
  result: DiffLine[];
}

const MAX_CACHE = 100;
const cacheMap = new Map<string, CacheEntry>();
const insertionOrder: string[] = [];

export function getCachedDiff(oldStr: string, newStr: string): DiffLine[] {
  const key = hashKey(oldStr, newStr);
  const cached = cacheMap.get(key);
  // Verify inputs match to guard against hash collisions
  if (cached !== undefined && cached.oldStr === oldStr && cached.newStr === newStr) {
    return cached.result;
  }

  const result = computeDiff(oldStr, newStr);

  if (cacheMap.size >= MAX_CACHE) {
    const oldest = insertionOrder.shift();
    if (oldest !== undefined) {
      cacheMap.delete(oldest);
    }
  }

  cacheMap.set(key, { oldStr, newStr, result });
  insertionOrder.push(key);

  return result;
}
