import { useEffect, useRef, useState } from 'react';
import { WS_URL, tokenStore } from '../api';
import { Collaborator, CollabClient, ConnStatus } from './client';

export interface CollabState {
  client: CollabClient | null;
  text: string;
  status: ConnStatus;
  role: string;
  seq: number;
  collaborators: Collaborator[];
  /** Latest title pushed by the server (rename by someone else), if any. */
  remoteTitle: string | null;
  error: string | null;
  dismissError(): void;
}

/** Owns one CollabClient for the lifetime of the editor page and mirrors its state into React. */
export function useCollab(docId: string, userId: string): CollabState {
  const [client, setClient] = useState<CollabClient | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [role, setRole] = useState('viewer');
  const [seq, setSeq] = useState(0);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<CollabClient | null>(null);

  useEffect(() => {
    const token = tokenStore.get();
    if (!token) return;
    setText('');
    setStatus('connecting');
    setCollaborators([]);
    setError(null);
    const c = new CollabClient(
      { wsUrl: WS_URL, token, docId, userId },
      {
        onChange: () => setText(clientRef.current?.rga.text() ?? ''),
        onStatus: setStatus,
        onRole: setRole,
        onPresence: setCollaborators,
        onMeta: setRemoteTitle,
        onError: setError,
        onSeq: setSeq,
      },
    );
    clientRef.current = c;
    setClient(c);
    c.connect();
    return () => {
      c.close();
      clientRef.current = null;
      setClient(null);
    };
  }, [docId, userId]);

  return {
    client,
    text,
    status,
    role,
    seq,
    collaborators,
    remoteTitle,
    error,
    dismissError: () => setError(null),
  };
}
