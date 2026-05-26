-- Smart collections. A collection with a non-NULL `query` field
-- resolves its membership from a saved-search rule at view time
-- instead of from the `collection_members` join table. Static
-- collections (the original kind) keep working with query=NULL.
--
-- The query is JSON-encoded — keeps the schema flexible for adding
-- new filter dimensions (mime kind, date ranges, glob patterns)
-- without another migration. Validation lives in the route layer
-- via zod.
ALTER TABLE collections ADD COLUMN query TEXT;
