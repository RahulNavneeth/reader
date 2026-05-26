-- Provenance for docs created from a template. Stores the source
-- template path + the JSON-serialised vars the user passed, so the
-- "Refresh from template" path can re-render with the same inputs
-- (date / time / uuid builtins re-compute to "now").
ALTER TABLE documents ADD COLUMN template_source TEXT;
