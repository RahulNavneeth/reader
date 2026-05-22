# Reader AI — In-Chat Document Editing (design)

**Status:** scoping doc, not yet built.
**Author:** Claude + Rahul (paired)
**Date:** 2026-05-21
**Target release:** v0.7

---

## Motivation

After v0.6, Reader AI can *read* documents and answer questions
about them. The natural next step is to let it *edit* them — from
the same chat surface. The 1.0 thesis ("can I trust Reader as my
only document system?") needs a workflow where the AI is an
active collaborator, not just a search interface.

The existing MCP granular-edit tools (`replace_section`,
`insert_after`, `delete_section`, `append_text`, `prepend_text`)
already do the disk work safely — they're the same primitives
external agents (Claude Code, custom scripts) use. v0.7 surfaces
them inside the chat panel so the user can drive edits in
natural language without leaving the doc.

## Trust model

**The model NEVER writes to disk.** It proposes; the user gates;
the server applies.

This matters because:

1. At 0.5b–3b the model hallucinates ~20% of the time. Direct
   disk writes would corrupt the vault.
2. The user owns the document. They should always see what's
   about to change.
3. The audit log + version history (v0.7 also includes diffing —
   see audit doc) becomes the source of truth for "did the
   model edit this?".

Flow:

```
User → "rewrite the intro to be terser"
  → Reader AI generates a <proposed_edit> block
    → Server detects + persists the block (no disk write yet)
      → UI shows the proposed change as a diff card
        → User clicks Apply
          → Server applies via existing mdx.ts ops
            → Audit + version snapshot
              → New content live
```

## Supported operations

Match the existing `lib/mdx.ts` API one-to-one. No new edit
primitives — anything the MCP tools can do, in-chat editing can do.

| op             | Target              | Effect                                                |
|----------------|---------------------|-------------------------------------------------------|
| `replace_section` | heading (exact text) | Replaces section body. Heading line preserved.        |
| `insert_after`    | heading (exact text) | Adds a new section right after the named one.         |
| `delete_section`  | heading (exact text) | Removes the heading + body entirely.                  |
| `append_text`     | (whole doc)         | Adds content at the end of the doc.                   |
| `prepend_text`    | (whole doc)         | Adds content at the start (after frontmatter).        |

Out of scope for v0.7:
- Line-level edits / single-token corrections — too granular for
  the diff-card UI, no clear ROI.
- Free-form patches — `git apply`-style 3-line context patches
  would need a real fuzzy match + conflict resolution UI.
- Non-markdown docs — PDF / image OCR edits require an
  extract-edit-re-ingest cycle that's its own ~10 hr feature.

## Wire format

The model emits proposed edits as XML-tagged blocks in its
streaming output. Server-side parser detects them in the
`assembled` buffer at stream-end.

```xml
<proposed_edit op="replace_section" heading="Big levers if you want to accelerate">
| Lever | Effect |
| --- | --- |
| Increase SIP by ₹10K every 2 years | FI age 40 → 36 |
| Avoid lifestyle inflation | FI shifts 2–3 yrs earlier |
| Step-up SIPs annually by 15% | FI shifts another 2 yrs |
</proposed_edit>
```

Why XML and not JSON: the model's output is markdown, often with
code fences containing JSON-like content. Tagged blocks parse
cleanly without bracket-balancing. We already use this pattern
(`<primary_sections>`, `<rules>`) so the model knows the convention.

Rules:
- One `<proposed_edit>` per atomic change.
- Multiple blocks per turn allowed (e.g. "rewrite the entire
  doc" → 4 sections replaced → 4 blocks → 4 diff cards).
- `op` attribute is required and case-sensitive.
- `heading` required for section ops, omitted for `append_text` /
  `prepend_text`.
- Body content between tags is the new section body (for
  `replace_section`) or the section to insert (for `insert_after`
  — must include the new heading line, e.g. `## New Section`).

## Schema

Migration 009:

```sql
-- pending_edit holds the JSON payload of a proposed edit. NULL
-- on user turns + assistant turns without edits. Non-null on
-- assistant turns where the model emitted <proposed_edit> blocks.
-- Multiple edits in one turn → JSON array of ops.
ALTER TABLE chat_messages ADD COLUMN pending_edit TEXT;

-- applied_at: timestamp of when the user clicked Apply. NULL
-- means still pending. Lets the UI render Apply / Discard vs.
-- "Applied 2 hrs ago" state, and prevents double-apply.
ALTER TABLE chat_messages ADD COLUMN edit_applied_at INTEGER;

-- doc_sha256 at proposal time. On Apply, server compares to
-- current. If mismatched → refuse, surface "doc changed under
-- the proposed edit" UI. Prevents stale model output from
-- silently overwriting recent manual edits.
ALTER TABLE chat_messages ADD COLUMN edit_target_sha256 TEXT;
```

## API surface

New endpoint:

```
POST   /api/chat/:docId/apply-edit
       { messageId }
```

- Looks up `chat_messages.pending_edit` by id (scoped to
  current user + doc).
- Refuses if `edit_applied_at` is non-null.
- Refuses if user lacks edit permission on the doc.
- Refuses if `doc_sha256` ≠ `edit_target_sha256` (stale).
- Otherwise: acquires per-doc edit lock, snapshots current
  version, applies each op via `lib/mdx.ts`, writes the new
  content via `writeFile`, audits, updates
  `edit_applied_at = Date.now()`, kicks ingest re-index.
- Returns `{ ok: true, version: { ... } }` on success.

Discard:

```
DELETE /api/chat/:docId/pending-edit/:messageId
```

- Drops the `pending_edit` payload (sets column to NULL).
- The chat message itself stays — its content (the user-visible
  proposed edit description) remains in history. Just the
  apply-able payload is gone.

No new memory routes — the memory system from v0.6 doesn't
intersect with editing.

## UI

### Diff card

Renders below an assistant message's content when
`message.pendingEdit != null`. Reuses the section heading from
the op so the user knows what's being changed.

```
┌─ Proposed edit ────────────────────────────────┐
│ Section: "Big levers if you want to accelerate" │
│ Operation: Replace section                      │
│                                                 │
│ ── Before ───────────────────────────────────── │
│ - Increase SIP by ₹10K every 2 years            │
│ - Avoid lifestyle inflation                     │
│ - Tilt allocation more aggressive at 22         │
│ ── After ────────────────────────────────────── │
│ + Increase SIP by ₹10K every 2 years            │
│ + Avoid lifestyle inflation                     │
│ + Tilt allocation more aggressive at 22         │
│ + Step-up SIPs annually by 15% [new line]       │
│                                                 │
│ [ Apply ]    [ Discard ]                        │
└─────────────────────────────────────────────────┘
```

Implementation:
- Use `diff` (lib already in our node_modules tree via vitest) or
  hand-roll a simple line diff for v1.
- Multiple proposed edits in one turn → stack of cards.

### Applied state

Once Apply lands, the card collapses to:

```
✓ Applied to "Big levers if you want to accelerate" — 2 minutes ago
```

Discarded state:

```
✗ Discarded
```

Both are persisted (via `edit_applied_at` / a separate discarded
flag) so the user can see the history of what they accepted vs
rejected when scrolling back.

### Conflict state

If sha256 mismatches at Apply time:

```
⚠ The document has changed since this edit was proposed.
   Re-ask Reader AI to regenerate the suggestion against the
   current state.
   [ Re-propose ]   [ Discard ]
```

The Re-propose button re-runs the user's original request.

## Prompt changes

New rule (rule 10 or similar) + a few-shot example showing the
edit shape:

```
10. STRUCTURED EDITS — When the user requests a document change
    (verbs: "rewrite", "change", "update", "fix", "add", "delete",
    "replace", "shorten", "expand"), emit your proposal as a
    structured block instead of free prose:

    <proposed_edit op="replace_section" heading="Section X">
    …new section body…
    </proposed_edit>

    Use `replace_section` to rewrite a section, `insert_after`
    to add a new section (include the new heading inside the
    block, e.g. "## New Heading\n…body…"), `delete_section` to
    drop one, `append_text` / `prepend_text` to add to the
    start or end of the doc.

    Always wrap the NEW content between the tags — never a diff
    against the old. The server computes the diff for display.

    A single edit request from the user can produce multiple
    <proposed_edit> blocks if the change spans multiple
    sections. The user sees one diff card per block and can
    Apply / Discard each independently.

    For QUESTIONS about the document (no mutation requested),
    do NOT emit <proposed_edit> — just answer normally.
```

Plus a few-shot:

```
<example_edit_request>
User: shorten the Caveats section
Reader AI: <proposed_edit op="replace_section" heading="Caveats">
This is a long-term projection. Markets vary; assumptions may not
hold. Recheck yearly.
</proposed_edit>
I've proposed a shorter version of the Caveats section. Review
the diff above and click Apply to save.
</example_edit_request>
```

## Open questions

1. **Discard preserves the chat message text?**
   Yes — the model's proposal text + reasoning stays in history
   as a normal assistant turn. Only the `pending_edit` JSON
   payload is dropped. So a user can scroll back and see "Reader
   AI suggested X, I discarded it."

2. **Multi-edit Apply: atomic, or independent per card?**
   v1: independent. Each card has its own Apply button. Trade-
   off: applying card 1 changes the doc sha256, breaking card
   2's `edit_target_sha256` check. UI shows the conflict
   state on subsequent cards.
   v2: optional "Apply all" button that runs ops in order,
   collapses sha256 check across the batch.

3. **Edit-before-applying?**
   Skip for v1. Pencil-edit on the proposed content adds a
   textarea + sha256 invalidation flow that's its own ~3hr
   build. Apply-as-is or Discard for v1.

4. **Cross-user editing on shared docs?**
   Only if the share grant is `editors`, not `readers`. Same
   permission rules as the manual edit path.

5. **What does the chat see after Apply?**
   The next chat turn's prompt should reflect the NEW doc
   content. Re-run the chat assemble pipeline — primary_sections
   for that doc now reads the updated text. No special handling
   needed; the existing `readText(docId)` on every turn picks
   up the change.

6. **0.5b model viability?**
   Documented: the structured-edit format fails ~50% at 0.5b.
   3B+ produces the right shape ~95% of the time. Same model-
   ceiling caveat as v0.6 — app is ready, model is the
   bottleneck.

## Phase / scope

**Phase A — Backend foundation (~3 hr)**
- Migration 009 (pending_edit + edit_applied_at + edit_target_sha256)
- `chatRepo.ts` extensions: read/write the new columns,
  `markEditApplied`, `clearPendingEdit`
- Service-side `parseProposedEdits(assembled)` — pulls all
  `<proposed_edit>` blocks out of the stream buffer, returns
  the structured ops
- Route: persist `pending_edit` JSON on assistant turns where
  the parser found blocks; compute + persist
  `edit_target_sha256` at the same time
- Unit tests for the parser (edge cases: nested tags, malformed
  ops, multiple blocks, missing attrs)

**Phase B — Apply / Discard endpoints (~2 hr)**
- `POST /api/chat/:docId/apply-edit` — apply via mdx.ts ops,
  audit, version snapshot, sha256 check
- `DELETE /api/chat/:docId/pending-edit/:messageId` — drop
  payload
- Integration tests covering: happy path, sha256 mismatch,
  cross-user refusal, double-apply idempotency

**Phase C — UI (~3 hr)**
- New `ProposedEditCard.tsx` component — line diff, Apply /
  Discard buttons, three states (pending, applied, discarded,
  conflict)
- Hook into `ChatDock`'s Bubble: render the card stack below
  assistant content when `message.pendingEdit` is set
- Mount Conflict state when Apply returns 409

**Phase D — Prompt + tests (~1 hr)**
- New rule + few-shot in `buildOllamaMessages`
- Integration smoke: drive end-to-end edit proposal + apply
  against a real Ollama model (gated on model availability;
  skip when 0.5b is in use)

**Total: ~9 hr** — fits inside v0.7's window alongside version
diffing.

## Risks

| Risk | Mitigation |
| --- | --- |
| Model emits malformed `<proposed_edit>` block | Parser returns null for malformed; assistant turn renders as normal text. No silent partial apply. |
| Model proposes edit to a section that doesn't exist | Apply-edit refuses with a "section not found" error; UI shows error state. |
| Doc changes between propose + apply | sha256 check rejects, UI shows conflict state with re-propose option. |
| User accidentally applies a hallucinated rewrite | Diff card is the gate — user sees the full new content before clicking Apply. |
| Model emits edit + prose in same turn | Both render — proposal as diff cards, prose as normal markdown content below. Both persist. |
| Multiple edits race against each other | Per-doc edit lock (already in `lib/mdx.ts`) serialises. |
| Ingest re-index lags behind apply | Apply blocks until `ingestDocument` returns; chat sees the new text on the next turn. |

## Decision needed before Phase A starts

- Confirm scope (the 5 ops above, nothing more for v1)
- Confirm trust model (model proposes, user gates) — no
  auto-apply mode in v1
- v1 multi-edit policy: independent Apply per card (sha256 will
  invalidate later cards when an earlier one lands)
- One open detail: should the diff renderer be line-based (cheap,
  good enough for most edits) or character-based (more accurate,
  ~2× the implementation effort)? My recommendation: line-based.
