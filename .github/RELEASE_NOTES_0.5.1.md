# v0.5.1

Single-fix patch: markdown asset and link resolution.

## What changed

Markdown documents can now reference other vault files with normal
relative paths and have them render correctly.

Previously, writing `![photo](./photos/sunset.jpg)` inside a doc at
`notes/trip.md` produced a broken image. The browser resolved the
URL relative to the SPA route (`/notes/trip.md` → `/notes/photos/
sunset.jpg`) and got a 404.

Now custom `<img>` and `<a>` renderers rewrite relative URLs into:

- **Images** → `/api/file/raw?path=<resolved>&owner=<owner-if-shared>`
- **Internal links** → `<resolved>` routed through the SPA so the
  file viewer opens the linked doc natively

Pass-through cases (no rewrite):

- Absolute URLs with a scheme (`http://`, `https://`, `mailto:`, `data:`)
- Server-absolute API paths (`/api/...`)
- Pure in-page fragments (`#section`)

Handled relative forms:

- `./photo.jpg`, `photo.jpg` — sibling
- `./photos/sunset.jpg` — descendant folder
- `../2025/jan.md` — parent traversal
- `/architecture.md` — vault-root absolute
- Trailing `?foo=bar` query strings and `#anchor` fragments are
  preserved

Cross-owner shares: the `?owner=` query string is carried through
on all rewritten URLs so a recipient browsing a shared subtree
stays in the shared context.

## Why this is a patch

No new tables, no new endpoints, no API changes. Pure presentation
fix in `apps/web/src/components/PathViewer.tsx` + the new
`apps/web/src/lib/markdownAssetResolver.ts` helper. Backwards
compatible.

## Pull

```
docker pull ghcr.io/rahulnavneeth/reader:0.5.1
```
