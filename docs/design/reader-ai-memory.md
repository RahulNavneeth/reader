# Reader AI — Memory System (design)

**Status:** scoping doc, not yet built.
**Author:** Claude + Rahul (paired)
**Date:** 2026-05-20

---

## Motivation

The CLAUDE.md best-practices article identified three behaviors that make
an LLM agent *feel reliable*:

1. **Remembers decisions** across sessions
2. **Learns from past failures** instead of repeating them
3. **Holds permanent project/user facts** that always apply

Reader AI today has none of these. Every conversation starts cold: the
system prompt + the supplied document + the (doc, user) chat history.
That means:

- Every time the user asks about "my portfolio", they have to re-establish
  context (currency: ₹, target allocation, what they consider "aggressive")
- If Reader AI hallucinates and the user corrects it, the correction is
  forgotten as soon as the conversation moves on or the page reloads
- Cross-document insights ("I told you last week my income tier is X")
  vanish

This doc scopes a memory system that closes those gaps.

## Three memory tiers

| Tier            | Scope             | Lifetime  | Mutability | Storage             |
|-----------------|-------------------|-----------|------------|---------------------|
| **Permanent**   | per-user          | forever   | user-only  | `user_memories`     |
| **Doc memory**  | per-(user, doc)   | until doc | user-only  | `doc_memories`      |
| **Failure log** | per-user, global  | forever   | system+user | `chat_error_notes` |

### 1. Permanent (user-level facts)

Facts that are always true for this user. Loaded into every system prompt.

**Examples:**
- "Currency is ₹ unless told otherwise."
- "I prefer 1-sentence answers."
- "When I say 'my portfolio', I mean the 55/25/10/5/5 deployment."

**Storage** — new table `user_memories`:
```sql
CREATE TABLE user_memories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  source      TEXT NOT NULL, -- 'user_command' | 'auto_extracted'
  created_at  INTEGER NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_user_memories_user ON user_memories(user_id);
```

**Capture path:** explicit user command via the chat composer:
- `/remember <fact>` — appends a row
- `/forget <substring>` — soft-deletes matching rows
- `/memories` — lists all current memories in the panel

**Surface in prompt:** appended to the system prompt as
`<permanent_facts>` block, capped at 20 entries (1.5KB) so it doesn't
balloon the context. Ordered by `used_count DESC, created_at DESC`.

### 2. Doc memory (per-document scratchpad)

Facts the user has corrected or clarified *about this specific doc*.

**Examples:**
- "When the doc says 'PPFCF', that's Parag Parikh Flexi Cap Fund."
- "The 'aggressive' label here is the user's chosen target, not a
  market-standard term."

**Storage** — new table `doc_memories`:
```sql
CREATE TABLE doc_memories (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_doc_memories_doc_user ON doc_memories(doc_id, user_id);
```

**Capture path:**
- Explicit: user uses `/remember-here <fact>` in the doc's chat
- Implicit (v2, deferred): when the user corrects Reader AI ("no, X means Y"),
  the server stores Y as a doc memory automatically. Requires
  correction-detection — out of scope for v1.

**Surface in prompt:** appended as `<doc_facts>` block, only when
opening this specific doc's chat. Capped at 10 entries.

### 3. Failure log (system-learned)

When Reader AI gives a wrong answer and the user signals it
(thumbs-down, "that's wrong", or explicit correction), log the
question + the wrong answer + the correction.

**Storage** — new table `chat_error_notes`:
```sql
CREATE TABLE chat_error_notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  doc_id      TEXT,   -- optional: present when scoped to a doc
  question    TEXT NOT NULL,
  wrong_answer TEXT,
  correction  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

**Capture path:**
- 👎 button on every assistant turn (new UI)
- User types correction in a follow-up; assistant turn that follows
  saves the previous Q + the new correction as a row
- Out of scope for v1: any model-based extraction

**Surface in prompt:** retrieved by embedding the current user
question against `chat_error_notes.question` (BM25 or cosine via
existing embed pipeline), top-3 included as a `<known_mistakes>`
block in the system prompt. Tells the model "you got this wrong
before; the correct answer was X."

---

## API surface

New routes, all gated by `app.requireUser`:

```
GET    /api/memories            → list user-level memories
POST   /api/memories            → { fact }            add a permanent memory
DELETE /api/memories/:id        → drop one

GET    /api/chat/:docId/memories     → list doc-scoped memories
POST   /api/chat/:docId/memories     → { fact }        add doc memory
DELETE /api/chat/:docId/memories/:id → drop one

POST   /api/chat/:docId/feedback     → { messageId, kind: 'wrong', correction? }
                                        records a chat_error_note
```

The chat composer recognises slash commands client-side and routes
them to these endpoints instead of `POST /api/chat/.../stream`:
- `/remember <fact>` → `POST /api/memories`
- `/remember-here <fact>` → `POST /api/chat/:docId/memories`
- `/memories` → fetches both lists and renders an inline assistant
  turn with the contents (no model call)
- `/forget <id-or-text>` → DELETE matching rows

---

## UI changes

1. **Memories panel** — a small "Memories" affordance in the chat
   header (next to Clear) opens a side popover listing all permanent
   + doc-scoped memories with X-to-delete buttons. New memory text
   field at the top of the popover.

2. **Slash-command suggestion menu** — when the user types `/` in
   the composer, a dropdown lists available commands with inline
   help text.

3. **👍 / 👎 on assistant turns** — replaces nothing; sits next to
   the existing Copy + Regenerate row actions. 👎 opens a small inline
   form: "What should the answer have been?" → submit → recorded as
   a `chat_error_note`.

4. **Used-memory hint** — when a system prompt includes one or more
   relevant `user_memories` or `chat_error_notes`, the assistant
   turn shows a tiny "Used memory: <preview>" footer (similar to
   the Sources panel).

---

## Phase / scope

**v1 (this milestone):**
- Tables: `user_memories`, `doc_memories`, `chat_error_notes`
- APIs: list / add / delete
- Slash commands: `/remember`, `/remember-here`, `/memories`, `/forget`
- Prompt injection: `<permanent_facts>`, `<doc_facts>`
- 👎 button + correction form → records `chat_error_notes`
- `<known_mistakes>` retrieval via the existing embed service

**v2 (later):**
- Auto-extracted memories (model proposes "should I remember X?"
  after a user correction; user one-click approves)
- 👍 reinforces memory used_count
- Cross-user memory sharing (admin-curated workspace facts)
- Memory expiry (decay weakly-used rows after 90 days)

---

## Open questions

1. **Capacity ceilings.** A user with 200 permanent memories drowns
   the system prompt. Cap at 20 surfaced, sort by `used_count DESC`?
   Or run a similarity filter against the current query?

2. **Privacy.** Memories are per-user; an admin can technically read
   them via the DB. Worth encrypting at rest? Probably not for v1
   (no other Reader data is encrypted at rest), but flag for later.

3. **Failure-log retrieval cost.** Embedding every user question
   against `chat_error_notes.question` adds an embed call per chat
   turn. Acceptable on local Ollama; document the cost for cloud
   deployments.

4. **Slash-command discoverability.** Do we educate via tooltip,
   docs, or first-run hint? Probably a small "?" affordance next to
   the composer that opens the command list.

---

## Estimate

| Task                          | Effort       |
|-------------------------------|--------------|
| Migration + repos for 3 tables | 1 hr        |
| API routes + tests             | 2 hr        |
| Slash-command parser + routing | 1.5 hr      |
| Prompt injection of memories   | 1 hr        |
| 👎 button + correction UI     | 2 hr        |
| Memories panel UI              | 2 hr        |
| Embedding-based mistake retrieval | 1 hr     |
| End-to-end smoke + regression tests | 1.5 hr |
| **Total (v1)**                 | **~12 hr**  |

---

## Decision needed before building

- ✅ scope = the v1 list above
- Picking the slash-command verb convention (`/remember` vs `:remember`?)
- 👎 form: free-text only, or also a "category" picker (factually wrong / off-topic / wrong tone)?
- Are doc memories scoped to (doc, user) or shared per doc across users with read access?
