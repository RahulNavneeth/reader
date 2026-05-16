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
- Pin files or folders to the sidebar
- Drag-and-drop upload, bulk select + bulk public/private/pin/share/delete
- Trash with 30-day retention and per-file deletion countdown
- Versions per file, recent-activity audit per file/folder

**Multi-user**
- Per-user vaults (`<VAULT_ROOT>/<username>/…`)
- First signup becomes admin; admin invites the rest via Settings → Users
- Role-based: `admin` / `editor` / `viewer`
- Per-user upload quotas, per-user re-index, per-user API tokens + webhooks
- User-to-user shares (folder or file, read-only or read+write)
- Public links with optional password + expiry; folder shares cascade

**Search**
- Hybrid lexical + semantic (Ollama embeddings, RRF-merged)
- Filename + tag search in the sidebar
- ⌘K command palette with file matches + quick actions

**AI agents**
- MCP endpoint at `/mcp` (Bearer token from Settings → API tokens)
- 11 tools: search, list, get, list_folder, upload_text, set_tags,
  pin, whoami, etc. Acts as the token's user.

**Photo map**
- `/map` plots geotagged photos on OpenStreetMap (pigeon-maps)
- EXIF GPS extracted on ingest via `exifr`; lazy-backfilled for legacy images
- Proximity clustering, zoom-to-fit, date-grouped cluster sidebar

**Other**
- Streaming ZIP export of an account's vault + manifest (constant memory)
- Memories ("On this day" carousel from past years)
- Light / dark theme
- All themed dialogs (no native `window.confirm`)

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
| `SMTP_*` | _disabled_ | If `SMTP_ENABLED=true`, sends real email; otherwise logs to stdout. |

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

Tests (vitest smoke suite — path traversal guards, ZIP encoder, GPS extraction):

```bash
npm test
```

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite, TailwindCSS, react-markdown, pigeon-maps, lucide |
| Backend | Fastify (Node 22), `@fastify/multipart`, `chokidar`, `sharp`, `@napi-rs/canvas`, `pdfjs-dist`, `exifr` |
| Search | Ollama (`nomic-embed-text` by default) + in-process lexical index |
| Storage | Filesystem |
| Container | Debian-slim, non-root, ~400 MB |

---

## License

MIT — see [LICENSE](./LICENSE).
