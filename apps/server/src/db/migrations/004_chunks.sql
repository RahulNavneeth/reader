-- Chunk text + embeddings moved out of the in-memory Float32Array
-- cache (services/search.ts) into SQLite so a 100K-chunk corpus
-- stops pinning ~3 GB of resident memory.
--
-- We still store chunks.jsonl on disk as a per-doc backup the
-- watcher / debugger can `cat` for sanity-checking, but reads go
-- through this table.
--
-- Embedding stored as a BLOB of little-endian float32s — a 768-dim
-- nomic-embed-text vector is 3 KB per row. SELECTing one chunk back
-- and reconstructing the Float32Array is essentially free; the
-- query that scans for vector similarity does a streamed scan with
-- doc-level pre-filtering by the (doc_id, idx) index.
--
-- Why a regular table (and not a sqlite-vec virtual table): vec0
-- needs a native extension loaded at connection-open time, which
-- means Dockerfile surgery + a per-platform binary. JS-side cosine
-- against streamed BLOBs is simpler to ship and stays well-bounded
-- for the corpus sizes Reader is realistically deployed at.

CREATE TABLE chunks (
  doc_id      TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  -- NULL when Ollama was unavailable at ingest time. Search treats
  -- those rows as text-only (lexical only).
  embedding   BLOB,
  -- Captured at write-time so search can group by dim and skip rows
  -- from a model swap without re-embedding everything.
  embed_dim   INTEGER,
  PRIMARY KEY (doc_id, idx),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- doc_id index already implicit in the composite PK; an explicit
-- one isn't needed.

-- Indexed by length so the search code can pre-filter to "rows that
-- have an embedding" without scanning the BLOB. NULL bytes is null
-- in SQL, so we just `WHERE embedding IS NOT NULL`.
CREATE INDEX idx_chunks_embedded ON chunks(doc_id) WHERE embedding IS NOT NULL;
