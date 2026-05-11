# Reader

A self-hosted document vault. Files live on disk as a normal folder tree
(Obsidian-style); the app indexes them for AI agents and humans.

## Features

- **Filesystem-backed vault** — every file is just a real file on disk, so it
  stays editable in Finder, Obsidian, vim, etc.
- **Hybrid search** — lexical scoring fused with vector cosine search over
  Ollama embeddings. RRF-merged, snippet-highlighted.
- **⌘K command palette** — global search across the corpus *and* quick actions
  (new folder, upload, move/rename).
- **Folder grid** — Finder-style empty state with breadcrumbs, type-aware
  icons, and click-to-navigate.
- **Upload destination picker** — every upload prompts for a destination,
  pre-filled with your current folder.
- **Public/private toggle** — flip a file public from the header and the same
  `/docs/<path>` URL is readable without auth. Private files require login.
- **Anonymous viewer** — hitting a public file's URL in incognito renders the
  file with minimal chrome, no login wall.
- **Content negotiation on `/docs/<path>`** — browsers get the SPA viewer,
  CLIs (wget, curl, fetch) get the raw bytes. No redirects, no leaked
  internal endpoints.
- **MD outline** — markdown files get a TOC panel on the right with
  click-to-scroll.
- **Dynamic tab title + favicon** — both update to match the file you're
  viewing; favicon icons match the sidebar/grid glyphs.
- **MCP integration** — the server exposes an MCP endpoint so AI agents can
  query the vault.
- **Auth + roles** — admin/editor/viewer, sessions cookies, audit log,
  long-lived API tokens.
- **Re-index button** — if Ollama was down at upload time, one click
  re-extracts and re-embeds.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite, TailwindCSS, react-markdown, lucide icons |
| Backend | Fastify (Node 22), multipart uploads, JSON file stores |
| Search | Ollama (`nomic-embed-text` by default) + in-memory chunk index |
| Storage | Local disk (vault under `~/Documents/Reader-Vault` by default) |
| Optional | S3-compatible object storage (MinIO/R2/AWS) for blobs |

## Repo layout

```
apps/
  server/   Fastify API + ingest pipeline + search service
  web/      React SPA (Vite dev on :5174, /api proxied to :3001)
packages/
  shared/   Cross-cutting types (in progress)
data/       Runtime state: users, sessions, document meta, audit log
            (gitignored — only .gitkeep is tracked)
```

## Getting started

Prerequisites: Node 22, Ollama running with `nomic-embed-text` pulled, an
existing vault directory.

```bash
# 1. Install
npm install

# 2. Copy env template and edit
cp .env.example .env
#   set SESSION_SECRET (openssl rand -hex 32)
#   set READER_ROOT to your vault path (defaults to ~/Documents/Reader-Vault)

# 3. Run dev (server :3001, web :5174 with HMR + /api proxy)
npm run dev
```

Open <http://localhost:5174>, sign up the first admin user, drop a file into
the dropzone, and try ⌘K.

## URL conventions

| URL | What you get |
|---|---|
| `/docs/<path>` in a browser | SPA viewer (auth-gated unless file is public) |
| `/docs/<path>` via `wget`/`curl` | Raw file bytes (auth-gated unless public) |
| `/api/file/raw?path=<path>` | Internal — same as above, used by the server |
| `/api/search/knowledge?q=…` | Hybrid search hits |
| `/mcp` | MCP server endpoint for AI agents |

## Public sharing

In the file header, click **Private** to flip to **Public**. The URL
`/docs/<path>` stays the same and becomes anonymously readable. Click
**Public** again to lock it back down.

Folder-level sharing is not implemented yet — coming.

## License

ISC.
