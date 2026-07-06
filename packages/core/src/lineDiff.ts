/**
 * Line-level diff statistics.
 *
 * Counts inserted and deleted lines between two text versions using an
 * LCS-based Myers O(ND) diff: unchanged lines cost nothing, an inserted line
 * is +1 added, a deleted line is +1 removed, and a modified line is one
 * delete plus one insert (+1/+1). This is a true edit distance, not a length
 * delta — reordering or a same-length rewrite still reports real churn.
 */

/**
 * Above this many lines on either side the Myers matrix and its trace become
 * expensive (worst case O(N·D) time and O(N²) space), so oversized inputs fall
 * back to a cheap net-delta approximation that never allocates the edit graph.
 */
const MAX_DIFF_LINES = 20_000;

/**
 * The D-loop is quadratic in the edit distance, so two large files that share
 * almost nothing (distance → n+m) would burn hundreds of millions of diagonal
 * steps even under the line cap. Past this many edits the exact split stops
 * being informative ("basically rewritten"), so the search bails and the
 * caller falls back to the net-delta approximation. ~5k edits keeps the worst
 * case around 12M steps — well under a frame of extension-host time.
 */
const MAX_EDIT_DISTANCE = 5_000;

export interface LineChangeCounts {
  readonly added: number;
  readonly removed: number;
}

export function countLineChanges(before: string, after: string): LineChangeCounts {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // Fallback: net delta only. Beyond the cap the full diff is too costly, so we
  // report the minimum forced churn (surplus insertions/deletions by count).
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    return {
      added: Math.max(0, afterLines.length - beforeLines.length),
      removed: Math.max(0, beforeLines.length - afterLines.length)
    };
  }

  return myersCounts(beforeLines, afterLines);
}

/**
 * Splits on either newline convention so a pure CRLF↔LF re-encoding of the same
 * content diffs as zero changes. A trailing newline yields a trailing empty
 * line on both sides, which cancels out.
 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Myers O(ND) diff reduced to insert/delete counts. `d` is the edit distance
 * (total inserts + deletes); with the common-prefix/suffix trim and the final
 * length identity we recover added and removed without reconstructing the path.
 */
function myersCounts(a: readonly string[], b: readonly string[]): LineChangeCounts {
  // Trim the matching prefix and suffix: they never contribute edits and keep
  // the search band small for the common "few edits in a large file" case.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const trimmedA = a.slice(start, endA);
  const trimmedB = b.slice(start, endB);
  const n = trimmedA.length;
  const m = trimmedB.length;
  if (n === 0) {
    return { added: m, removed: 0 };
  }
  if (m === 0) {
    return { added: 0, removed: n };
  }

  const distance = editDistance(trimmedA, trimmedB, n, m);
  if (distance === -1) {
    // Edit distance exceeded MAX_EDIT_DISTANCE: report the minimum forced
    // churn instead of stalling on a near-total rewrite.
    return { added: Math.max(0, m - n), removed: Math.max(0, n - m) };
  }
  // The edit script is `distance` steps of insert/delete; each delete shrinks
  // the length by one and each insert grows it, so removed + added = distance
  // and added − removed = m − n. Solving: removed = (distance − (m − n)) / 2.
  const removed = (distance - (m - n)) / 2;
  const added = distance - removed;
  return { added, removed };
}

/**
 * Classic Myers edit-distance search over the trimmed sequences. Returns -1
 * when the distance exceeds MAX_EDIT_DISTANCE (caller falls back).
 */
function editDistance(a: readonly string[], b: readonly string[], n: number, m: number): number {
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  // v[k + offset] = furthest-reaching x on diagonal k after d edits.
  const v = new Int32Array(2 * max + 1);
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!; // insertion (down)
      } else {
        x = v[k - 1 + offset]! + 1; // deletion (right)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        return d;
      }
    }
  }
  // Distance exceeds the capped search band; the caller approximates instead.
  return -1;
}
