/**
 * Per-document mutex for vault writes.
 *
 * Two concurrent calls that read → mutate → write the same file
 * would race: both read the same initial bytes, compute different
 * outputs, and writeFile silently overwrites one. The lock pins
 * the read → apply → write → saveMeta sequence to one in-flight
 * chain per docId.
 *
 * Single-node only — multi-instance deploys would need a real
 * distributed lock, but Reader is single-process today. Both the
 * MCP granular-edit tools (`routes/mcp.ts`) and the chat
 * apply-edit endpoint (`routes/chat.ts`) share this map, so a
 * concurrent agent + chat edit on the same doc serialises.
 */
const editLocks = new Map<string, Promise<void>>()

export async function withEditLock<T>(
  docId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = editLocks.get(docId) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => (release = r))
  // Chain off the previous holder. .catch shields us from a prior
  // failure tearing down the lock; the new holder still runs.
  editLocks.set(
    docId,
    prev.catch(() => undefined).then(() => next),
  )
  await prev.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    // Drop the entry only if no one else has chained behind us so
    // the map doesn't leak. Race-safe because Map.get returns the
    // CURRENT tail; if our next is still the tail, no one's queued.
    if (editLocks.get(docId) === next) editLocks.delete(docId)
  }
}
