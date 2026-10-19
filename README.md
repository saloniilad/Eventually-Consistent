# Eventually Consistent

A **real-time collaborative text editor** where many people edit the same document at once and everyone always ends up with the same text, even when edits arrive late, duplicated or out of order. Merging is done by an **RGA sequence CRDT** instead of locks or "last write wins".

**Stack:** TypeScript · Node.js · WebSocket · PostgreSQL · React · Vite · Docker

> 📸 Add a screenshot or demo GIF here: `docs/demo.gif`

---

## Features

**Collaboration**
- Live multi-user editing with instant local typing (edits apply locally first, then sync)
- Remote cursors and selections in each user's colour, with name labels
- Collaborator avatars and a connection status indicator
- Per-user **undo / redo**: you only undo your own edits, never a collaborator's

**Conflict-free merging**
- Every character has a unique ID; concurrent inserts are ordered the same way on every client
- Deletes are tombstones, so they combine safely with any other edit
- Operations are idempotent and buffered, so duplicates and out-of-order delivery still converge
- Randomised convergence tests check that replicas end up identical

**History**
- Append-only operation log with periodic snapshots
- **Time travel**: view the document at any earlier point
- Line-by-line diff against the current text
- Restore an old version as a *new* edit, so no history is lost

**Reliability**
- PostgreSQL persistence (plus an in-memory store for quick local runs)
- Restart recovery: latest snapshot + replay of later operations
- Automatic reconnect with backoff; offline edits are queued and re-sent
- Reconnecting clients receive only the operations they missed

**Security**
- Password hashing (bcrypt) and signed tokens (JWT)
- Roles: **owner**, **editor**, **viewer** (viewers get a read-only editor)
- Every WebSocket message is validated; users cannot forge operation IDs
- Rate limiting, document size cap, security headers, CORS allowlist

---

## Architecture

```
┌──────────────┐   REST (auth, docs, history)    ┌────────────────────────┐
│   React UI   │ ───────────────────────────────▶│                        │
│              │                                 │   Node.js server       │
│ local RGA    │   WebSocket (ops, presence,     │   · auth + roles       │
│ replica      │ ◀──────────────────────────────▶│   · session manager    │
└──────────────┘   undo/redo, sync)              │   · server RGA copy    │
                                                 └───────────┬────────────┘
                                                             │
                                              ┌──────────────▼─────────────┐
                                              │ PostgreSQL                 │
                                              │ · users, documents, roles  │
                                              │ · append-only operation log│
                                              │ · snapshots                │
                                              └────────────────────────────┘
```

**How an edit travels**
1. You type. The browser diffs the text and turns it into insert/delete operations.
2. The operations are applied to the local replica immediately, then sent over the WebSocket.
3. The server validates them, appends them to the log, applies them to its own copy and broadcasts them.
4. Other clients apply them with the same merge rules, so all replicas converge.

**Design choices**
- **RGA CRDT over operational transformation:** no central transformation logic, and operations commute, which makes reconnects and retries safe.
- **CRDT is a standalone module** with no network or database code, so it can be tested in isolation. The frontend uses an exact copy.
- **Undo as compensating operations:** undo creates new operations that reverse your own earlier edits, so it never rewinds other people's work.
- **Cursors anchored to character IDs**, not numeric positions, so they stay correct while text changes around them.

---

## Repository layout

```
.
├── backend/    Node.js + TypeScript server, CRDT, persistence, tests
└── frontend/   React + Vite client
```

Each folder has its own README with more detail.

---

## Getting started

**Prerequisites:** Node.js 20+, and (optionally) Docker for PostgreSQL.

### 1. Backend
```bash
cd backend
npm install
cp .env.example .env        # set a strong JWT_SECRET
# Option A: PostgreSQL via Docker
docker compose up -d
npm run migrate
# Option B: quick run with the in-memory store (data is lost on restart)
npm run dev
```
The server listens on **http://localhost:4000** by default.

### 2. Frontend
```bash
cd frontend
npm install
cp .env.example .env        # VITE_API_URL=http://localhost:4000
npm run dev
```
Open **http://localhost:5173**.

### 3. Try it
1. Register two users in two different browser windows.
2. Create a document in the first window and click **Share** with the second user's email.
3. Open the document in both windows and type at the same time.
4. Turn off your network briefly, keep typing, then reconnect to see the edits sync.
5. Open **History**, drag the slider, and restore an older version.

> Check the backend README for the exact script names and environment variables if they differ from the above.

---

## Testing

```bash
cd backend && npm test      # unit, convergence, session, recovery, WebSocket integration
cd frontend && npm test     # text-diff helpers
```

CI runs formatting, lint, typecheck, tests and build on every push (GitHub Actions).

---

## Known limitations

- Runs as a **single server instance**; scaling out would need sticky routing per document or a pub/sub layer.
- Plain text only (no rich formatting or comments).
- Each character is one element and deleted characters are never garbage-collected, so very large documents slow down. A block-based structure and tombstone cleanup would address this.
- Undo steps are roughly one per keystroke or paste.
- No offline merging of edits across separate devices after a long disconnect.

## Possible next steps

- Block-based storage and tombstone garbage collection
- Rich-text formatting layer
- Horizontal scaling with Redis pub/sub
- Comments and suggestions
- Load testing and published latency numbers

