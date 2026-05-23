/**
 * Line-level diff utilities. Shared between VersionDiffView /
 * ProposedEditPreview (which render full ins/del/eq sequences)
 * and the DocRail (which only needs the added / removed line
 * counts to show a tiny "+5 −2" summary on each row).
 *
 * Implementation: standard LCS over line arrays + backtrack.
 * Caps each side at 4000 lines so a pathological doc doesn't
 * freeze the tab. The cap also bounds memory: 4000² = 16 M
 * cells × 4 bytes/cell (Uint32Array) = 64 MB worst case, which
 * we tolerate but rarely hit (markdown docs typically <1000
 * lines).
 */

export type DiffOp = { kind: 'eq' | 'ins' | 'del'; line: string }

const MAX_LINES = 4000

export function computeLineDiff(oldText: string, newText: string): DiffOp[] {
  if (oldText === newText) return []
  let a = oldText.split('\n')
  let b = newText.split('\n')
  if (a.length > MAX_LINES) a = a.slice(0, MAX_LINES)
  if (b.length > MAX_LINES) b = b.slice(0, MAX_LINES)
  const m = a.length
  const n = b.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]
    }
  }
  const stack: DiffOp[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      stack.push({ kind: 'eq', line: a[i - 1] })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      stack.push({ kind: 'del', line: a[i - 1] })
      i--
    } else {
      stack.push({ kind: 'ins', line: b[j - 1] })
      j--
    }
  }
  while (i > 0) {
    stack.push({ kind: 'del', line: a[i - 1] })
    i--
  }
  while (j > 0) {
    stack.push({ kind: 'ins', line: b[j - 1] })
    j--
  }
  return stack.reverse()
}

/** Just the +/- counts — what the DocRail needs to show "+5 −2"
 *  on each row without rendering the full diff. Cheap to call
 *  per row because we already have the full LCS pipeline. */
export function computeLineDiffCounts(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const op of computeLineDiff(oldText, newText)) {
    if (op.kind === 'ins') added++
    else if (op.kind === 'del') removed++
  }
  return { added, removed }
}
