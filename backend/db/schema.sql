-- Eventually Consistent: PostgreSQL schema (idempotent; safe to run on every boot).

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,            -- stored lower-case
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  owner_id   UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Document-level access control.
CREATE TABLE IF NOT EXISTS document_members (
  doc_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX IF NOT EXISTS document_members_user_idx ON document_members (user_id);

-- Append-only operation log. `seq` is the total order the server assigned.
-- UNIQUE (doc_id, op_id) makes retries and duplicate delivery idempotent:
-- the second insert of the same CRDT op hits ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS operations (
  seq        BIGSERIAL PRIMARY KEY,
  doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  op_id      TEXT NOT NULL,                       -- 'i:<site>:<n>' or 'd:<site>:<n>' (see opKey)
  user_id    UUID NOT NULL REFERENCES users(id),  -- who authored / triggered the op
  site_id    TEXT NOT NULL,                       -- replica that generated it ('server' for undo/restore)
  op         JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, op_id)
);
CREATE INDEX IF NOT EXISTS operations_doc_seq_idx ON operations (doc_id, seq);

-- Periodic snapshots of the full RGA state (including tombstones) at a given seq.
CREATE TABLE IF NOT EXISTS snapshots (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,                     -- state includes every op with seq <= this
  state      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)
);
CREATE INDEX IF NOT EXISTS snapshots_doc_seq_idx ON snapshots (doc_id, seq DESC);
