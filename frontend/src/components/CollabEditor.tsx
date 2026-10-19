import { ChangeEvent, KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Collaborator, CollabClient, Cursor } from '../collab/client';
import { cpToUtf16, utf16ToCp } from '../lib/textdiff';

interface Props {
  client: CollabClient;
  text: string;
  collaborators: Collaborator[];
  readOnly: boolean;
}

/**
 * A plain <textarea> kept in sync with the CRDT replica.
 *
 * - Typing: the new value is diffed against the replica and turned into insert/delete ops.
 * - Remote edits: the textarea value is replaced, and the local caret is restored from
 *   *element-id anchors*, so it does not jump when someone edits above it.
 * - Remote cursors/selections are drawn on a transparent "backdrop" layer behind the
 *   textarea that has the same text and metrics, so no pixel measurements are needed.
 */
export function CollabEditor({ client, text, collaborators, readOnly }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const lastLocal = useRef(text);
  const selRef = useRef<Cursor>({ anchor: null, head: null });
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollbar, setScrollbar] = useState(0);

  // ---- local selection -> element-id anchors (+ throttled presence broadcast) ----
  function captureSelection() {
    const ta = taRef.current;
    if (!ta) return;
    const v = ta.value;
    const s = utf16ToCp(v, ta.selectionStart);
    const e = utf16ToCp(v, ta.selectionEnd);
    const sId = client.rga.idAtVisible(s - 1);
    const eId = client.rga.idAtVisible(e - 1);
    const backward = ta.selectionDirection === 'backward';
    selRef.current = backward ? { anchor: eId, head: sId } : { anchor: sId, head: eId };
    if (presenceTimer.current) return;
    presenceTimer.current = setTimeout(() => {
      presenceTimer.current = null;
      client.sendPresence(selRef.current);
    }, 80);
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    lastLocal.current = v;
    client.edit(v);
    captureSelection();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') {
      // The server owns undo history (per user, via compensating ops): block the native one.
      e.preventDefault();
      if (readOnly) return;
      if (k === 'y' || e.shiftKey) client.redo();
      else client.undo();
    }
  }

  // Block the browser's own undo/redo (menu, context menu, mobile gestures).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const handler = (ev: Event) => {
      const t = (ev as InputEvent).inputType;
      if (t === 'historyUndo' || t === 'historyRedo') {
        ev.preventDefault();
        if (readOnly) return;
        if (t === 'historyUndo') client.undo();
        else client.redo();
      }
    };
    ta.addEventListener('beforeinput', handler);
    return () => ta.removeEventListener('beforeinput', handler);
  }, [client, readOnly]);

  // ---- after a remote change, put the caret back where it logically was ----
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (text !== lastLocal.current) {
      lastLocal.current = text;
      if (document.activeElement === ta) {
        const a = client.rga.cursorIndex(selRef.current.anchor);
        const h = client.rga.cursorIndex(selRef.current.head);
        const s = cpToUtf16(text, Math.min(a, h));
        const e = cpToUtf16(text, Math.max(a, h));
        ta.setSelectionRange(s, e, h < a ? 'backward' : 'forward');
      }
    }
    setScrollbar(ta.offsetWidth - ta.clientWidth);
  }, [text, client]);

  useEffect(() => {
    const onResize = () => {
      const ta = taRef.current;
      if (ta) setScrollbar(ta.offsetWidth - ta.clientWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(
    () => () => {
      if (presenceTimer.current) clearTimeout(presenceTimer.current);
    },
    [],
  );

  // ---- backdrop: remote selections + carets ----
  const backdrop = useMemo(() => {
    const cps = Array.from(text);
    interface Remote {
      c: Collaborator;
      head: number;
      lo: number;
      hi: number;
    }
    const remotes: Remote[] = [];
    for (const c of collaborators) {
      if (c.siteId === client.siteId || !c.cursor) continue;
      const a = client.rga.cursorIndex(c.cursor.anchor);
      const h = client.rga.cursorIndex(c.cursor.head);
      remotes.push({ c, head: h, lo: Math.min(a, h), hi: Math.max(a, h) });
    }
    const points = new Set<number>([0, cps.length]);
    for (const r of remotes) {
      points.add(r.head);
      points.add(r.lo);
      points.add(r.hi);
    }
    const sorted = [...points].filter((p) => p >= 0 && p <= cps.length).sort((x, y) => x - y);

    const caretsAt = (pos: number): ReactNode[] =>
      remotes
        .filter((r) => r.head === pos)
        .map((r) => (
          <span key={`c-${r.c.siteId}`} className="rcaret">
            <span className="rcaret-line" style={{ borderColor: r.c.color }} />
            <span className="rcaret-label" style={{ background: r.c.color }}>
              {r.c.name}
            </span>
          </span>
        ));

    const nodes: ReactNode[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const pos = sorted[i];
      nodes.push(...caretsAt(pos));
      const next = sorted[i + 1];
      if (next === undefined) break;
      const seg = cps.slice(pos, next).join('');
      const sel = remotes.find((r) => r.lo < r.hi && r.lo <= pos && next <= r.hi);
      nodes.push(
        sel ? (
          <mark key={`m-${pos}`} style={{ background: `${sel.c.color}40` }}>
            {seg}
          </mark>
        ) : (
          <span key={`t-${pos}`}>{seg}</span>
        ),
      );
    }
    nodes.push(<span key="end"> </span>); // keeps a trailing newline's height
    return nodes;
  }, [text, collaborators, client]);

  return (
    <div className="editor-wrap">
      <div
        ref={backRef}
        className="editor-surface editor-backdrop"
        style={{ paddingRight: 28 + scrollbar }}
        aria-hidden="true"
      >
        {backdrop}
      </div>
      <textarea
        ref={taRef}
        className="editor-surface editor-input"
        value={text}
        readOnly={readOnly}
        spellCheck
        placeholder={readOnly ? '' : 'Start typing… everyone sees it live.'}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={captureSelection}
        onKeyUp={captureSelection}
        onClick={captureSelection}
        onFocus={captureSelection}
        onScroll={(e) => {
          if (backRef.current) backRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        aria-label="Document text"
      />
    </div>
  );
}
