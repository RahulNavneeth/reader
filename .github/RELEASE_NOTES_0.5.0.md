# v0.5.0

The Collections release. A flat, virtual grouping layer on top of the
vault — a document can sit in any number of collections without being
copied or moved. Plus a storage-layer migration to SQLite, public
collection URLs for anonymous viewers, share-cascade for collection
recipients, a rebuilt Activity log, and a pile of UX polish.

Backwards-compatible — existing data migrates on first boot, JSON
backups still written. Pull and restart.

## Collections

A new top-level concept distinct from folders. Folders are physical
(a file lives in exactly one folder); collections are virtual (a file
can be a member of many at once). Pages live at `/collections` and
`/c/:id`; a Collections link is in the user menu.

- **Mosaic cover art.** Each collection card renders a 2×2 thumbnail
  mosaic (4+ items), a full-bleed single cover (1–3 items), or a
  filename tile for non-media docs.
- **File-toolbar Collections button.** Tags-style anchored popover
  with a chip field, search-as-you-type filter, create-and-add row,
  keyboard nav, and stay-open behavior. The trigger flips to
  "1 collection" / "N collections" with the accent color when the
  doc has memberships.
- **Bulk add-to-collection** in the folder-grid selection toolbar.
  Visible only when the selection is files-only (folders aren't
  collection members by design).
- **Share with another user** (read or edit). The owner can flip
  permissions inline and revoke from a single popover that mirrors
  the Public/Private popover shape.
- **Share cascade.** When alice shares a collection with bob, bob
  can read every member doc through the normal `/api/file/*`
  endpoints — no per-doc grant needed.
- **Public collection URLs.** Owner publishes with optional password
  + preset expiry (1/7/30 days/never), gets a stable
  `/pc/<slug>` URL. Anonymous viewers land on a read-only grid with
  a lightbox for media. Revoke any time.

## SQLite-backed document index

The audit's "in-memory vector index won't scale" line has been
addressed. Documents, tags, ACLs, and chunk embeddings now live in
SQLite (`data/reader.db`) instead of being loaded into a process-wide
Map at boot. Practical effect: a 100k-chunk corpus drops from ~3 GB
resident to whatever the active query needs.

- New `documents`, `document_tags`, `document_acl_*`, `chunks`,
  `collections`, `collection_members`, `collection_shares` tables.
- Migrations run on every boot; idempotent.
- One-shot bootstrap reads existing `meta.json` + `chunks.jsonl`
  files into SQL on first boot of the new version.
- `meta.json` files are still written as a per-doc backup the user
  can `cat` for debugging.

## Bulk tags (files + folders)

`POST /api/file/bulk-tags` accepts a mixed selection of file and
folder paths and dispatches to the right metadata store. A bulk
"Tags" trigger lives in the folder-grid selection toolbar with the
familiar search-and-create popover shape. Sidebar tag counts update
live via SSE after every bulk operation.

## Activity, rebuilt

The Activity popover went from a developer log to a real timeline:

- Grouped by relative time — `Today` / `Yesterday` / `This week` /
  `Earlier`.
- Action-typed icons (upload cloud, pencil for edits, hard-drive for
  external on-disk edits, sparkles for MCP/AI agent writes, lock for
  visibility, users for shares).
- Natural-language phrasing. `alice uploaded this · 5m ago` instead
  of `vault.upload`.
- **MCP attribution.** A row reads `alice wrote this via MCP (1.2 KB)`
  with the actual token user as the actor.
- **External-edit attribution.** Changes detected by the on-disk
  watcher render as `Edited on disk by an external tool · 5m ago`
  with a HardDrive icon, no awkward "system" actor.

## MCP improvements

- `search_knowledge` now surfaces the per-source RRF score breakdown
  inline in the text response (`lexical=0.0123 semantic=0.0456 …`) —
  previously hidden in `structuredContent` only.

## Bug fixes

- **EXDEV cross-device trash** — files now move correctly to
  `/data/trash` when `/vault` and `/data` are separate volume mounts
  (default in docker/podman compose). `moveAcrossDevices` falls back
  to `cp + rm` on EXDEV.
- **Token "Copy" button silently failing** on Permissions-Policy-
  locked contexts (`docs.rahulmnavneeth.in`). New clipboard helper
  with `isSecureContext` guard + legacy `execCommand` fallback.
- **Bulk-delete silent failures** — endpoint now returns
  `{ok, failed, errors: [{path, reason}]}` with structured server
  logs. Per-file reason surfaced in the UI.
- **Bulk-tag sidebar count stuck** until hard refresh. Endpoint now
  publishes per-path SSE `tags` events; sidebar auto-refreshes.
- **Reply.sendFile not a function** — wasn't actually a bug. Stale
  NixOS systemd unit on the tester's machine.

## UX

- **Compact share modal.** The big centered share dialog is gone;
  collections now have separate Share + Public/Private anchored
  popovers that match the file toolbar's family.
- **Toolbar popover family.** Tags, Collections, Activity, Versions,
  Share, Public, and Private all share the same header-bar shape
  (icon + title + status pill). Open-state shows selected background
  + accent text consistently.
- **Centered overlays for New Folder + Upload.** Portaled through
  `document.body` so a transformed ancestor doesn't clamp
  `position: fixed`. New Folder pre-fills the current path; both
  use autocomplete against existing folders.
- **Timeline shows all documents**, not just media.
- **Photo timeline duplicates** under StrictMode mount-twice — fixed
  via ref-based in-flight guard and dedupe by `docId`.
- **Metadata sidebar header border** aligned to the App header's
  bottom border at the same y.
- **Toolbar popover order** — Public/Private moved before Pin in
  folder controls so their centered popovers don't clip the right
  viewport edge.
- **Folder selection toolbar** now exposes Tags, Collections (files-
  only), Share, Pin, Public/Private, and Delete uniformly.

## Upgrade notes

- **First boot will import existing `data/documents/<id>/meta.json`
  files into SQLite.** Idempotent and safe to re-run. Existing
  `chunks.jsonl` files are also imported.
- `data/reader.db` is the new authoritative store. Back it up as
  part of `data/`.
- `meta.json` and `chunks.jsonl` files continue to be written as
  per-doc backups; you can delete them in a future release if you
  want to reclaim disk space.
- New env var: `CLIP_ENABLED=true` (opt-in, default off) for image
  semantic search. No effect if unset.
- No breaking API changes. The vestigial `DocumentMeta.collectionId`
  field is preserved but ignored — collections membership lives in
  the join table.

## Behind the scenes

- ffmpeg, libraw-bin, and better-sqlite3 are baked into the image.
- The Dockerfile ships migrations alongside the compiled JS.
- Multi-arch image (`linux/amd64` + `linux/arm64`) pushed by the
  Release workflow to `ghcr.io/rahulnavneeth/reader:0.5.0`.

## Deferred (by design)

- Face recognition / person grouping
- Mobile app with auto-upload
- Memories / on-this-day
- In-browser photo editing

These remain open per earlier scope conversations. v0.6 territory.

---

**Pull and run**:

```
docker pull ghcr.io/rahulnavneeth/reader:0.5.0
docker compose up -d --force-recreate
```

For self-hosters using `:latest`, this is what `:latest` now points
at.
