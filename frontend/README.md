# Eventually Consistent — Frontend

React + TypeScript (Vite) client for the **Eventually Consistent** backend: a real-time collaborative plain-text
editor whose replicas converge through an **RGA sequence CRDT**.

## Quick start

```bash
npm install
cp .env.example .env      # set VITE_API_URL if the backend is not on http://localhost:4000
npm run dev               # http://localhost:5173
```

The backend's default `CORS_ORIGIN` is `http://localhost:5173`, so it works out of the box. For another origin,
add it to the backend's `CORS_ORIGIN`.

Scripts: `npm run dev` · `npm run build` (typecheck + production bundle in `dist/`) · `npm run typecheck` · `npm test`.

Try it: open the app in two browser windows, register two users, create a document in one, share it
(Share → the other user's email), open it in both and type at the same time.

## What is implemented

| Feature                       | Where                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Register / login / logout     | `src/pages/AuthPage.tsx`, `src/auth.tsx` (JWT kept in `localStorage`)                                   |
| Create, list, open, rename    | `src/pages/DocsPage.tsx`, `src/pages/EditorPage.tsx`                                                    |
| Local CRDT replica            | `src/crdt/rga.ts` (exact copy of the backend file)                                                      |
| WebSocket sync + reconnect    | `src/collab/client.ts`, `src/collab/useCollab.ts`                                                       |
| Editor bound to the replica   | `src/components/CollabEditor.tsx`                                                                       |
| Remote cursors & selections   | anchored to element ids, drawn on a backdrop layer in `CollabEditor.tsx`                                 |
| Collaborator list & status    | avatars + connection pill in `EditorPage.tsx`                                                           |
| Per-user undo / redo          | toolbar buttons and Ctrl/⌘+Z, Ctrl/⌘+Shift+Z / Ctrl+Y (server-side compensating ops)                    |
| Version history / time travel | `src/components/VersionPanel.tsx` (slider, snapshot chips, diff vs current, text view, restore)         |
| Sharing & roles               | `src/components/ShareDialog.tsx` (owner only); viewers get a read-only editor                           |

## How it works

1. **Typing.** The textarea's new value is diffed against the replica (common prefix/suffix, in code points).
   The result becomes delete + insert ops, applied to the local RGA immediately and sent as one `ops` message.
2. **Remote ops** (`ops`, `sync`, `snapshot`) are applied with `rga.apply` (idempotent, order-independent). The
   textarea is re-rendered and the local caret is restored from the element ids it was anchored to, so it does not
   jump when someone edits above it.
3. **Presence** is sent separately (`presence`, throttled to ~80 ms) and never touches the operation log. Cursor
   anchors are element ids, so remote carets stay on the right character while text changes around them.
4. **Reconnect.** The client keeps un-acked batches. On reconnect it rejoins with `since = lastSeq` and receives only
   the missed ops; un-acked batches are re-sent (the server de-duplicates by op id). If the server rejects a batch
   (`missing_dependency`, `doc_too_large`, ...) the client discards its local state and loads a fresh snapshot.
5. **Undo/redo** is owned by the server per user: the client only sends `{type:"undo"}` / `{type:"redo"}` and applies
   the compensating ops that come back like any other remote edit. Native browser undo is blocked.

The tab's `siteId` is `"<userId>~<random>"` as the backend requires; a new random suffix is used per page load, so
operation ids can never collide.

## Keeping the CRDT in sync with the backend

`src/crdt/rga.ts` must match `backend/src/crdt/rga.ts`. If you change the merge rules on the server, copy the file here.

## Deployment

`npm run build` produces static files in `dist/`. Host them on any static host (Netlify, Vercel, Cloudflare Pages,
S3 + CDN, nginx). Build with `VITE_API_URL=https://your-backend` (use `https`, so the socket becomes `wss`) and add the
site's origin to the backend's `CORS_ORIGIN`. For client-side routing, configure the host to serve `index.html` for
unknown paths (SPA fallback).

## Known limitations

- Plain text only; the editor is a `<textarea>`, so there is no rich-text formatting.
- Undo steps follow the backend: one step per sent batch, i.e. roughly per keystroke or paste.
- The element list is O(n) per operation, like the backend; fine for documents of tens of thousands of characters.
- The token lives in `localStorage` and travels in the WebSocket URL query string (use `wss://`).
- Role changes apply the next time a collaborator opens the document.
