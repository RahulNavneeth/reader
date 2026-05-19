-- Public collection URLs. Adds the same {public, public_expires_at,
-- public_password_hash} trio that documents already have, so anyone
-- with the link (and optionally the password) can view the
-- collection + its items without an account.
--
-- public_slug is a short URL-safe identifier the client renders as
-- /pc/<slug>. We don't reuse the primary id for the URL because the
-- nanoid id is opaque + 21 chars and the public link is something
-- the user pastes — keeping it short is nicer.

ALTER TABLE collections ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN public_expires_at INTEGER;
ALTER TABLE collections ADD COLUMN public_password_hash TEXT;
ALTER TABLE collections ADD COLUMN public_slug TEXT;
CREATE UNIQUE INDEX idx_collections_public_slug ON collections(public_slug) WHERE public_slug IS NOT NULL;
