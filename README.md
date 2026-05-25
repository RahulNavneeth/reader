# Reader

[![CI](https://github.com/RahulNavneeth/reader/actions/workflows/ci.yml/badge.svg)](https://github.com/RahulNavneeth/reader/actions/workflows/ci.yml)

A self-hosted document vault. Files live on disk as a normal folder tree
(Obsidian-style); the app gives every file a viewer, search index, shareable
links, and an MCP endpoint for AI agents.

Single-node, single Docker image, runs on a Mac mini or Raspberry Pi.

---

## Features

**File browser**
- Folder grid with thumbnails (images, PDFs, video frames)
- Inline viewers for PDF, markdown, CSV, JSON, images, audio, video
- Custom-chrome audio/video player (play/pause/seek/mute/fullscreen)
- HLS adaptive video streaming for large files (ffmpeg-transcoded on ingest)
- Pin files or folders to the sidebar
- Drag-and-drop upload, bulk select + bulk public/private/pin/share/delete
- Trash with 30-day retention and per-file deletion countdown
- Versions per file with diff + restore; per-file activity audit

**Multi-user**
- Per-user vaults (`<VAULT_ROOT>/<username>/…`)
- First signup becomes admin; admin invites the rest via Settings → Users
- Role-based: `admin` / `editor` / `viewer`
- Per-user upload quotas, per-user re-index, per-user API tokens + webhooks
- User-to-user shares (folder or file, read-only or read+write)
- Public links with optional password + expiry; folder shares cascade

**Search**
- Hybrid lexical + semantic (Ollama embeddings, RRF-merged)
- Optional CLIP image search — text query against image content, fused
  into the same ranking (see [Image search (CLIP)](#image-search-clip))
- Faceted filters: `mime`, `tags`, `folder`, `after`, `before`
- Find-similar: `/api/search/similar/:docId` returns docs by chunk-centroid cosine
- Saved searches via `/api/views` (sidebar)
- Filename + tag search in the sidebar
- ⌘K command palette with file matches + quick actions

**Reader AI (per-document chat)**
- Right-rail chat panel on any document — ask questions, get answers
  with citations
- Per-(user, doc) threads; memory system for permanent / per-doc facts
  + known mistakes
- In-chat editing: model proposes a structured `<proposed_edit>` op;
  user previews + accepts/rejects per op
- Backed by any Ollama chat model (`OLLAMA_CHAT_MODEL`, default
  `qwen2.5:7b-instruct`); 3B+ recommended for reliable structured-edit
  output

**AI agents (MCP)**
- MCP endpoint at `/mcp` (Bearer token or OAuth 2.1)
- **36 tools** across read, edit, search, organize, and richer
  PDF/CSV inspection — see [Connecting AI agents](#connecting-ai-agents-mcp)
- OAuth 2.1 + Dynamic Client Registration so Claude Code / Desktop /
  Cursor / Inspector connect by URL — no token paste, browser consent,
  per-tool scopes, per-user revoke from Settings → Connected apps
- Per-token rate limiting (60-burst, 5/sec refill) + `mcp.throttled` audit

**Webhooks**
- Subscribe per-user or workspace-wide to 16 vault events: `upload`,
  `edit`, `delete`, `trash`, `move`, `mkdir`, `share`, `tags`,
  `visibility`, `folder-tags`, `folder-visibility`, `pin`, `intake`,
  `template`, `export`, `ingest`
- HMAC-signed deliveries, retries with exponential backoff, dead-letter
  queue + manual retry, per-hook delivery log
- See [Webhooks](#webhooks)

**Email intake**
- HTTP-based forward-to-vault: `POST /api/intake/email`
- Wire any forwarder (CloudMailin, Postmark, Mailgun route → webhook,
  self-hosted ImprovMX, Apps Script) to deposit the body + attachments
  under `Inbox/YYYY-MM-DD-<slug>.md`
- Per-token scoping so a forwarder can only land in one user's vault

**Document templates**
- Drop `*.md` files in `_templates/` with `{{date}}`, `{{title}}`,
  `{{user}}`, or custom variables
- Instantiate from the UI or via `POST /api/templates/instantiate`
- Refuses paths outside `_templates/` and clobber-by-default

**Browser extension**
- MV3 capture extension under `apps/extension`
- One-click "Save to Reader" from any page → readability-extracted
  markdown lands in the vault, immediately searchable + MCP-queryable
- Bearer-token auth, reuses `/api/intake/email`

**Offline (PWA)**
- vite-plugin-pwa: SPA shell precached; runtime network-first cache
  for `/api/file/{text,meta,raw}` so recently-viewed docs stay
  readable on a plane
- Offline banner + `useOnlineStatus` hook

**Photo map + timeline**
- `/map` plots geotagged photos on OpenStreetMap (pigeon-maps)
- EXIF GPS extracted on ingest via `exifr`; lazy-backfilled for legacy images
- Proximity clustering, zoom-to-fit, date-grouped cluster sidebar
- `/api/account/calendar` returns per-day activity counts for a
  GitHub-style heatmap on the timeline

**Other**
- Streaming ZIP export of an account's vault + manifest (constant memory)
- Memories ("On this day" carousel from past years)
- Light / dark theme
- All themed dialogs (no native `window.confirm`)
- Live Photo pair detection (still + motion siblings tagged on ingest)

---

## Quick start (Docker)

```bash
# 1. Pick a directory for your stack, e.g. ~/reader
git clone https://github.com/RahulNavneeth/reader.git ~/reader
cd ~/reader

# 2. Generate a session secret (>= 32 chars, do this once)
printf "SESSION_SECRET=%s\n" "$(openssl rand -hex 32)" > .env

# 3. Bring it up
docker compose up -d

# 4. Open http://localhost:3001 — the first signup becomes admin
```

That's it. Files land under `./_state/vault/<username>/…` on the host; you
can `rsync` that to a NAS for backup.

To pull the embedding model so semantic search works (one-time, ~270 MB):

```bash
docker compose exec ollama ollama pull nomic-embed-text
```

If you don't want semantic search at all, comment out the `ollama` service
in `docker-compose.yml` and set `OLLAMA_ENABLED=false`. The app falls back
to lexical-only search.

---

## Configuration

All config is environment variables. Defaults are fine for a LAN install.

| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | — | **Required.** ≥ 32 chars. Generate with `openssl rand -hex 32`. |
| `APP_URL` | `http://localhost:3001` | Public URL the app is served at. Required if `COOKIE_SECURE=true`. |
| `COOKIE_SECURE` | `false` | Set to `true` behind an HTTPS reverse proxy. |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`. |
| `SESSION_TTL_DAYS` | `30` | How long a session cookie lives. |
| `ALLOWED_ORIGINS` | _empty_ | Comma-separated CORS allowlist for production. Localhost is auto-allowed in dev. |
| `ALLOW_OPEN_SIGNUP` | `false` | If true, anyone can sign up. Otherwise only the first user (auto-admin) + admin-issued accounts. |
| `MAX_FILE_BYTES` | `104857600` (100 MB) | Upload size cap. Bump if storing video / large archives. |
| `DATA_DIR` | `/data` | App state (users, sessions, meta, audit). Mount a volume. |
| `VAULT_ROOT` | `/vault` | User files. **This is the directory to back up.** Mount a volume. |
| `WEB_DIR` | `/app/apps/web/dist` | Where the SPA bundle is. Don't change in Docker. |
| `SERVER_HOST` / `SERVER_PORT` | `0.0.0.0` / `3001` | Bind address. |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Where to reach Ollama. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Any Ollama embed model works. |
| `OLLAMA_ENABLED` | `true` | Set false to skip semantic search entirely. |
| `OLLAMA_CHAT_MODEL` | `qwen2.5:7b-instruct` | Reader AI model. Any installed Ollama chat model works; 3B+ recommended for the structured-edit format. |
| `CHAT_ENABLED` | `true` | Disable to hide the chat dock + reject `/api/chat/*`. |
| `CLIP_ENABLED` | `false` | Opt-in image search. See [Image search (CLIP)](#image-search-clip). |
| `CLIP_DEVICE` | `cpu` | `cpu` / `cuda` / `webgpu`. Auto-falls back to CPU on load failure. |
| `CLIP_DTYPE` | `fp32` | `fp32` / `fp16` / `q8` / `int8`. |
| `CLIP_MODEL` | `Xenova/clip-vit-base-patch32` | Any transformers.js-compatible CLIP model. |
| `SMTP_*` | _disabled_ | If `SMTP_ENABLED=true`, sends real email; otherwise logs to stdout. |
| `SESSION_SECRET_PREVIOUS` | _unset_ | Old session secret kept valid for one rotation cycle — see [Session-secret rotation](#connecting-ai-agents-mcp). |

Most of these are also editable live in **Settings → General** once you're
signed in as admin.

---

## Storage layout

Two persistent directories you mount as volumes:

```
data/                    ← app state ($DATA_DIR)
├── users/               registered accounts (argon2 password hashes)
├── sessions/            active cookies
├── tokens/              API tokens (sha256-hashed)
├── documents/           per-doc meta, extracted text, embeddings, thumb/preview
├── folder-metas/        per-folder meta (tags, public flag)
├── user-shares/         user-to-user share grants
├── views/               saved sidebar filters
├── pins/                per-user pin lists
├── audit/               append-only audit log
├── trash/               trashed files (auto-purged at 30d)
└── settings.json        workspace settings

vault/                   ← user files ($VAULT_ROOT)
├── alice/
│   ├── investments/
│   │   └── notes.md
│   └── IMG_1234.heic
└── bob/
    └── …
```

Files in `vault/` are normal files — you can edit them in Finder / Obsidian /
vim and Reader picks up the changes via a filesystem watcher.

---

## Authoring markdown

The markdown renderer is GitHub-flavored (`remark-gfm`) with two
Reader-specific extensions: relative paths and Obsidian-style image
sizing.

### Linking files

Inside a markdown document you can reference other vault files
using normal relative paths. The renderer resolves them against the
document's parent folder.

```md
<!-- inside notes/trip.md -->

![sunset](./photos/sunset.jpg)
[itinerary](./itinerary.md)
[parent map](../map.geojson)
```

Resolves to:

- `notes/photos/sunset.jpg`
- `notes/itinerary.md`
- `map.geojson`

Behavior:

- **`./foo` / `foo`** — sibling, resolved against the doc's folder.
- **`../foo`** — parent traversal (multiple `../` supported).
- **`/foo`** — vault-root absolute (ignores the doc's folder).
- **`http://`, `https://`, `mailto:`, `data:`** — passed through
  unchanged.
- **`#section`** — in-page anchor, passed through (drives the
  outline jumps).

Images render through `/api/file/raw?path=…`; internal document
links navigate via the SPA so the file viewer takes over. If you're
browsing a shared subtree (`?owner=alice`), that hint is carried
through every rewritten URL so you stay in the shared context.

### Filenames with spaces

A space terminates the URL in standard markdown syntax. Use one of:

```md
![photo](./project%20abstract.png)     <!-- percent-encoded -->
![photo](<./project abstract.png>)     <!-- angle-bracket-wrapped -->
```

The renderer normalizes both into a single canonical encoding —
you can mix-and-match without worrying about double-encoding.

### Image sizing

Obsidian-compatible pipe syntax in the alt text:

```md
![photo|400](./trip.jpg)        <!-- width 400 px -->
![photo|400x300](./trip.jpg)    <!-- 400×300 px -->
![photo|50%](./trip.jpg)        <!-- 50% of container width -->
![photo|20em x 15em](./trip.jpg)
```

Supported units: bare number (`px` assumed), `px`, `%`, `em`, `rem`,
`vh`, `vw`. The `x` separator can also be `×` (the multiplication
sign).

Anything after the last `|` that isn't a parseable size is treated
as part of the alt text, so a real pipe inside alt text doesn't
accidentally trigger sizing.

The cleaned alt (text before the `|`) is what screen readers
announce — the size hint is dropped from the accessibility tree.

### What's NOT supported (yet)

- Pandoc-style attribute syntax (`![alt](url){width=400px}`) — use
  the pipe form instead.
- Wikilinks (`[[other-doc]]`) — Obsidian's bracket syntax doesn't
  render in CommonMark. Use the standard `[label](./other.md)` form.
- Transclusion / inline rendering of one doc inside another.

---

## Reader AI

Per-document chat panel — open any doc, ask questions, get answers
grounded in that document plus the rest of your vault.

**Setup**

```bash
# Pull a chat model (one-time):
docker compose exec ollama ollama pull qwen2.5:7b-instruct
```

That's the default. Anything Ollama can serve works — change
`OLLAMA_CHAT_MODEL` (or in Settings → General) to pick a different
one. Sub-3B models fail the structured-edit format ~half the time;
3B+ is the practical floor.

**In-chat editing**

When you ask Reader AI to edit the open doc, it emits a structured
`<proposed_edit>` op instead of free prose. The UI renders a diff
card with per-op Accept / Reject. The edit only runs server-side
after you click Accept — the model never writes directly.

Supported ops: `replace_section`, `insert_after`, `delete_section`,
`append_text`, `prepend_text`, `rewrite_file` (full overwrite, last
resort).

**Memories**

Slash commands in the composer persist user-scoped facts that
Reader AI sees on every turn:

- `/remember <fact>` — permanent, applies in every chat
- `/remember-here <fact>` — scoped to the open doc
- `/memories` — list everything
- `/forget <substring>` — remove

Plus a "👎 Wrong" row action on any answer to log a correction the
model will see next time.

**Disable**

Set `CHAT_ENABLED=false` to hide the dock and reject `/api/chat/*`.
The doc viewer still works; the right rail just isn't there.

---

## Image search (CLIP)

Off by default. Turn it on if your vault has a lot of photos and
you want to find them by what's in them, not by filename.

**Local dev**

```bash
cd apps/server
CLIP_ENABLED=true CLIP_DEVICE=cpu CLIP_DTYPE=fp32 npm run dev
```

First image upload after this lazy-loads the model (`Xenova/clip-vit-base-patch32`,
~150 MB ONNX, cached under `$DATA_DIR/clip-cache/`). Subsequent
uploads embed instantly.

**Production (Docker)**

The compose stanza supports the env vars — add them to your `.env`:

```
CLIP_ENABLED=true
CLIP_DEVICE=cpu
CLIP_DTYPE=fp32
```

Then `docker compose up -d reader`. On the first image upload the
container fetches the model; mount `_state/data` so the cache
survives restarts.

**Backfill existing images**

CLIP writes the embedding sidecar on ingest. Images that landed
*before* you flipped `CLIP_ENABLED=true` have no sidecar and don't
appear in image search. Admin one-shot to re-ingest everything:

```bash
curl -X POST -b "your-admin-session" https://reader.example.com/api/admin/reembed-all
```

Long-running; large libraries take a while because each image hits
the ONNX runner sequentially. Progress is in the response.

**Devices**

- `cpu` — universal, works everywhere.
- `cuda` — only with the GPU image variant + NVIDIA Container Toolkit
  + `deploy.resources.reservations.devices` in compose. Apple Silicon
  has no CUDA — use `cpu` or try `webgpu`.
- `webgpu` — experimental, browser-grade WebGPU bindings.

On load failure the loader falls back to CPU silently. Verify it
actually works by checking `<docId>/clip.json` exists after an image
upload — if it doesn't, CLIP no-op'd.

---

## Webhooks

Per-user (or workspace-wide) subscriptions to vault events. Each
hook is an `(url, events[], secret?)` triple managed from
Settings → Webhooks.

**Event types** (16): `upload`, `edit`, `delete`, `trash`, `move`,
`mkdir`, `share`, `tags`, `visibility`, `folder-tags`,
`folder-visibility`, `pin`, `intake`, `template`, `export`, `ingest`.

`GET /api/account/webhooks/event-shapes` returns the exact JSON
payload schema for each, so receivers can wire up types ahead of
time.

**Delivery semantics**

- POST as JSON with `Content-Type: application/json`.
- If `secret` is set, signed with `X-Reader-Signature: sha256=<hmac>`
  over the raw body.
- Headers also include `X-Reader-Event: <type>` and a deep-link
  `itemUrl` field in the body.
- Retries with exponential backoff on 5xx / network errors. Hard
  4xx goes straight to dead-letter.
- Per-hook DLQ visible in the UI with a one-click "Replay" button.
- Circuit breaker opens after consecutive failures; recently-failed
  hooks are skipped for a cooldown window so a broken endpoint
  doesn't block the event loop.

**Watcher dedup**

In-app writers (chat apply-edit, MCP edits, vault upload, template
instantiate, email intake, trash restore) mark their expected disk
writes so chokidar's filesystem watcher doesn't fire a second
webhook for the same change. Receivers see exactly one event per
user action.

---

## Email intake

`POST /api/intake/email` accepts a JSON payload (subject, from,
content, attachments[base64]) and lands a markdown doc in
`Inbox/YYYY-MM-DD-<slug>.md` with attachments alongside.

Auth is via a per-user intake token (Settings → API tokens → "Intake
token" variant) so each forwarder lands in exactly one user's vault.

**Wiring**

Any inbound-email service that can POST a JSON webhook works:

| Provider | Notes |
|---|---|
| CloudMailin | "Multipart Normalized JSON" format maps cleanly. |
| Postmark Inbound | JSON template → POST to `/api/intake/email`. |
| Mailgun Routes | Route action `forward("https://reader.example.com/api/intake/email")` with form-data. |
| ImprovMX → script | Free MX, forward to a tiny Apps Script that re-POSTs JSON. |

Body schema:

```json
{
  "from": "store@example.com",
  "subject": "Your receipt",
  "content": "markdown or plain text body",
  "attachments": [
    { "name": "invoice.pdf", "content": "<base64>" }
  ]
}
```

Fires an `intake` webhook (single event for the whole batch — the
per-attachment writes are watcher-deduped).

---

## Document templates

Drop markdown files in `_templates/` at the root of your vault.
They show up in the "New from template" picker.

**Variables**

```md
---
title: {{title}}
created: {{date}}
author: {{user}}
---

# {{title}}

Notes from {{date}}.
```

Built-in: `{{date}}`, `{{title}}`, `{{user}}`. Pass custom variables
in the `vars` body of `POST /api/templates/instantiate`.

**Guarantees**

- Templates live only in `_templates/` — refused outside.
- Won't clobber: instantiating into an existing path returns 409.

---

## Browser extension

`apps/extension/` ships an MV3 capture extension. One click on any
webpage → readability-extracted markdown + URL metadata → posted to
your Reader instance via `/api/intake/email` → lands in `Inbox/`,
immediately searchable + chat-able.

**Install (dev)**

1. `cd apps/extension && npm run build` (produces `dist/`).
2. Chrome → `chrome://extensions` → enable Developer Mode →
   "Load unpacked" → select `dist/`.
3. Click the toolbar icon, paste your Reader URL + Bearer token,
   save.

**Permissions**: `activeTab`, `scripting`, `storage`. No host
permissions beyond the page you click on.

---

## Backup

Reader has no database. Two directories carry all state.

**Option A — one-shot tar.gz snapshot:**

```bash
docker compose exec reader node apps/server/dist/cli/backup.js --out /data
# writes /data/reader-backup-2026-05-16-231005.tar.gz inside the volume
```

The CLI accepts `--out`, `--data`, and `--vault` overrides; defaults match
the container's mount points.

**Option B — rsync:**

```bash
rsync -av --delete ./_state/data/  /path/to/backup/data/
rsync -av --delete ./_state/vault/ /path/to/backup/vault/
```

The vault is the irreplaceable part. `data/` can be regenerated (the app
will re-index on first run) but you'll lose tags, shares, pins, and the
audit log if you only restore the vault.

**Full account export** is also built in: each user can download a ZIP of
their files + a `manifest.json` of tags/shares/pins from **Account → Export
everything**.

---

## Leaving Reader

Reader stores everything as **plain files on disk**. Walking away means
copying two directories and forgetting Reader exists. No proprietary
format, no database lock-in, no per-row export script.

**The whole exit:**

```bash
rsync -av ./_state/vault/  /path/to/exported/vault/   # your files
rsync -av ./_state/data/   /path/to/exported/data/    # tags, shares, pins, audit
```

That's it. You can `docker compose down`, delete the Reader install, and
you still have everything you put in. Open the vault folder in Obsidian,
the Finder, Cursor, Neovim, `grep`, `rsync` it to a NAS — it's just files.

**What's in each directory:**

| Source | What survives | What it looks like |
|---|---|---|
| `vault/<username>/…` | Every file you uploaded, in its original folder structure, with original filenames. | A regular directory tree. PDFs, markdown, images, CSVs — exactly what you put in. |
| `data/documents/<docId>/` | Reader's per-doc metadata (tags, public flag, ACL), extracted plaintext, embedding chunks. Plain JSON. | Re-indexable from `vault/` alone, but keeping it preserves your tags, public links, and share grants. |
| `data/audit/` | Append-only history of every action (uploads, edits, shares, MCP calls). NDJSON. | Greppable. Survives across migrations. |
| `data/users/`, `data/sessions/`, `data/tokens/` | Account credentials (argon2 hashes), live sessions, API tokens. | Lift-and-shift to a new Reader install or discard. |

**Per-user export (no admin access required):**

Each user can download their slice independently from **Account → Export
everything**: a ZIP of their files + a `manifest.json` of every tag,
share, pin, and visibility flag. Recipients of cross-user shares get
referenced — the source of truth stays with the owner. Useful when one
person leaves but the workspace stays up.

**Re-importing into a new Reader instance:**

```bash
# On the new host:
rsync -av /path/to/exported/data/  ./_state/data/
rsync -av /path/to/exported/vault/ ./_state/vault/
docker compose up -d
```

That's it — same images, same accounts, same docs, same shares. No
data migration step, no schema upgrade. The vault is bytes, the
metadata is JSON, and Reader picks up where it left off.

**Re-indexing without `data/`:**

If you only have the vault (the `data/` dir got lost) you keep the
files but lose the per-doc metadata. Drop the vault into a fresh
install and run **Admin → Reindex** — it'll walk every file, extract
text, and rebuild the search index. You lose the tags/shares/audit;
the files come back intact.

**No lock-in promise, made structural:**

This isn't a marketing claim — the README walks you through the exit
path before you've even committed to the install. If a future Reader
release ever changes that, treat it as a bug.

---

## Upgrade

Published images live at `ghcr.io/rahulnavneeth/reader`. Pin to a major
version (`:1`) for safe upgrades, or `:latest` for the bleeding edge:

```bash
cd ~/reader
docker compose pull
docker compose up -d
```

Available tags: `latest`, `1`, `1.2`, `1.2.3` (semver — pick the precision
that matches your risk tolerance). Multi-arch (`linux/amd64`, `linux/arm64`).

If you're building from source instead:

```bash
git pull
docker compose up -d --build
```

Data format is stable across versions; the app tolerates older `meta.json`
shapes and lazily upgrades them on first read. There is no manual migration
step.

---

## Optional: S3-compatible blob store

If `STORAGE=s3` is set, file blobs go to an S3-compatible bucket
(MinIO / R2 / AWS) instead of the local `vault/` directory. The doc
index, sessions, tags, audit log, etc. still live on disk under
`data/` regardless.

Recommended bucket lifecycle rules to keep storage costs bounded:

```xml
<!-- AWS S3 / MinIO example -->
<LifecycleConfiguration>
  <Rule>
    <ID>tier-old-blobs-to-cheap</ID>
    <Status>Enabled</Status>
    <!-- Promote rarely-accessed bytes to Glacier / Deep-Archive
         (or MinIO equivalent) after a year. Reader re-fetches on
         demand; the latency hit is acceptable for cold reads. -->
    <Transition>
      <Days>365</Days>
      <StorageClass>GLACIER</StorageClass>
    </Transition>
  </Rule>
  <Rule>
    <ID>expire-multipart-aborts</ID>
    <Status>Enabled</Status>
    <!-- Reader uses single-part uploads but multipart aborts can
         accumulate from interrupted client SDKs. Sweep weekly. -->
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>7</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
  <Rule>
    <ID>noncurrent-version-cap</ID>
    <Status>Enabled</Status>
    <!-- If versioning is on (recommended for accidental-delete
         recovery), keep at most 5 non-current versions then expire. -->
    <NoncurrentVersionExpiration>
      <NoncurrentDays>30</NoncurrentDays>
      <NewerNoncurrentVersions>5</NewerNoncurrentVersions>
    </NoncurrentVersionExpiration>
  </Rule>
</LifecycleConfiguration>
```

Reader doesn't manage bucket policies — set these via `aws s3api
put-bucket-lifecycle-configuration` or the MinIO console, once,
when you provision the bucket.

## Reverse proxy

The app expects an HTTPS reverse proxy in front of it for any deployment
outside `localhost`. Minimal Caddy config:

```caddy
reader.example.com {
  reverse_proxy reader:3001
}
```

Then in `.env`:

```
APP_URL=https://reader.example.com
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://reader.example.com
```

---

## Connecting AI agents (MCP)

Reader exposes a Model Context Protocol endpoint at `/mcp` so AI
agents can search your vault, read files, and (if you grant write
scopes) create + edit them. **36 tools** are available; the agent
sees only the subset its scopes cover.

| Category | Tools |
|---|---|
| Identity | `whoami` |
| Browse | `list_documents`, `list_folder`, `resolve_path`, `list_pins`, `list_tags`, `list_versions` |
| Read | `get_document`, `get_outline`, `get_section`, `get_chunk` |
| Search | `search_knowledge` |
| Edit (markdown) | `replace_section`, `insert_after`, `append_to_section`, `delete_section`, `append_text`, `prepend_text` |
| Upload | `upload_text`, `upload_file`, `upload_from_url` |
| Organize | `set_tags`, `set_visibility`, `pin`, `unpin`, `move_file`, `mkdir`, `rmdir`, `delete_document`, `restore_version` |
| PDF | `get_pdf_outline`, `pdf_page_count`, `pdf_page_text` |
| CSV | `csv_columns`, `csv_rows`, `csv_query` |

Per-tool scopes (`tool:search_knowledge`, `tool:upload_text`, …) mean
a client granted only read scopes physically cannot write. Two ways
to authenticate:

### Option 1 — Static API token (1-step)

Best for personal scripts and quick CLI use.

1. Settings → API tokens → **New token**, copy the secret (shown once).
2. Point your client at the MCP URL with `Authorization: Bearer <token>`.

```bash
# Claude Code
claude mcp add --transport http reader https://reader.example.com/mcp \
  --header "Authorization: Bearer <YOUR_TOKEN>"
```

Tokens inherit the creator's role (admin / editor / viewer). Revoke
from the same UI; revocation is immediate.

### Option 2 — OAuth (Claude Desktop, Cursor, Inspector)

Best for end-user tools — they click "Connect" and walk a browser
consent flow, no token paste.

```bash
# Claude Code over OAuth (no --header needed; client negotiates)
claude mcp add --transport http reader https://reader.example.com/mcp
```

Under the hood: the client fetches `/.well-known/oauth-protected-resource`,
discovers the auth server, self-registers via Dynamic Client
Registration, and opens the consent page in a browser. You see the
client name + redirect host + a checklist of **per-tool scopes**
(one per tool, plus a few meta scopes like `mcp`). Approve what you
want; deny the rest.

**Managing connected apps**

- Each user: Settings → **Connected apps** — list active grants,
  revoke individually, optional "revoke on signout" toggle.
- Admins: Settings → **OAuth clients** — see every registered client
  (DCR is open), delete rogue or stale registrations.

**Session-secret rotation**

OAuth client secrets and webhook secrets are encrypted at rest with
a key derived from `SESSION_SECRET`. To rotate it safely:

1. Set `SESSION_SECRET_PREVIOUS=<old value>` and `SESSION_SECRET=<new value>` in `.env`.
2. Restart the server. Both keys now work for decryption.
3. Settings → **Webhooks** (admin) → **Rotate secrets** to re-encrypt
   everything under the new key.
4. Remove `SESSION_SECRET_PREVIOUS` from `.env` on the next deploy.

---

## Development

```bash
npm install
cp .env.example .env
# set SESSION_SECRET, VAULT_ROOT, DATA_DIR
npm run dev   # server :3001, web :5174 with HMR
```

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run typecheck
```

Tests:

```bash
npm test                    # full suite
cd apps/server && npm test  # server only (573 integration + unit tests)
cd apps/web    && npm test  # web (vitest + jsdom + RTL)
```

Server-side coverage spans every writer surface (vault, MCP, chat,
templates, intake, shares), the OAuth 2.1 flow, webhook delivery +
DLQ, watcher dedup, edit locking, version snapshots, per-token rate
limiting, search filters + find-similar, ACL guards, and the
markdown engine.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite, TailwindCSS, react-markdown, pigeon-maps, lucide, vite-plugin-pwa |
| Backend | Fastify v5 (Node 22), `@fastify/multipart`, `@fastify/formbody`, `chokidar`, `sharp`, `@napi-rs/canvas`, `pdfjs-dist`, `exifr`, `better-sqlite3` |
| Search | Ollama (`nomic-embed-text` default) + in-process lexical index + optional `@huggingface/transformers` CLIP (ONNX, cpu/cuda/webgpu) |
| Chat | Ollama (any chat model; `qwen2.5:7b-instruct` default) with structured-edit prompt format |
| Auth | Argon2 password hashing, signed session cookies, OAuth 2.1 + Dynamic Client Registration + PKCE for MCP |
| Storage | Filesystem for vault + meta; SQLite (WAL) for chat threads, OAuth clients, audit search |
| Container | Debian-slim, non-root, ~400 MB |

---

## License

MIT — see [LICENSE](./LICENSE).
