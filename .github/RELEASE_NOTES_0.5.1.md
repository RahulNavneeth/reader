# v0.5.1

Two presentation fixes for the markdown viewer: relative-path
resolution and image sizing. Closes a real "your notes can't
reference your photos" gap.

## Relative paths

Markdown documents can reference other vault files using normal
relative paths and have them render correctly.

Previously, `![photo](./photos/sunset.jpg)` inside a doc at
`notes/trip.md` produced a broken image — the browser resolved the
URL against the SPA route and got a 404.

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

Already-encoded URLs (`project%20abstract.png`) now round-trip
correctly. The earlier patch double-encoded them into
`project%2520abstract.png`; the resolver now decodes-then-encodes
each path segment so one canonical encoding lands in the final URL.

## Image sizing

Obsidian-compatible pipe syntax in the alt text:

```md
![photo|400](./trip.jpg)        — width 400px
![photo|400x300](./trip.jpg)    — 400×300px
![photo|50%](./trip.jpg)        — 50% width
![photo|20em x 15em](./trip.jpg)
```

Supported units: bare number (`px` assumed), `px`, `%`, `em`, `rem`,
`vh`, `vw`. The `×` multiplication sign also works.

The cleaned alt (text before the `|`) is what screen readers get;
the size hint is dropped from the accessibility tree.

## Documentation

Full docs for the markdown extensions added to the README under
**Authoring markdown**.

## Why this is a patch

No new tables, no new endpoints, no API changes. Presentation
fixes in `apps/web/src/components/PathViewer.tsx` plus the new
`apps/web/src/lib/markdownAssetResolver.ts` helper. Backwards
compatible.

## Pull

```
docker pull ghcr.io/rahulnavneeth/reader:0.5.1
```
