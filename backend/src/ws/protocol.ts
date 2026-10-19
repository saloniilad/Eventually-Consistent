import { z } from 'zod';
import type { Op, RgaSnapshot } from '../crdt/rga';

/** siteId = `${userId}~${suffix}`; the charset excludes ':' which idKey() uses as a separator. */
export const SiteIdSchema = z.string().regex(/^[A-Za-z0-9_~-]{1,100}$/);

export const IdSchema = z
  .object({
    c: SiteIdSchema,
    n: z
      .number()
      .int()
      .min(1)
      .max(2 ** 40),
  })
  .strict();

const CharSchema = z
  .string()
  .refine(
    (s) => s.length >= 1 && s.length <= 2 && Array.from(s).length === 1,
    'exactly one code point',
  );

export const OpSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('insert'), id: IdSchema, ref: IdSchema.nullable(), ch: CharSchema })
    .strict(),
  z.object({ type: z.literal('delete'), target: IdSchema }).strict(),
]);

const CursorSchema = z.object({ anchor: IdSchema.nullable(), head: IdSchema.nullable() }).strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('join'),
    docId: z.string().uuid(),
    siteId: SiteIdSchema,
    /** Last server seq the client has seen. Omit for a fresh snapshot. */
    since: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('ops'),
    msgId: z.string().max(64).optional(),
    ops: z.array(OpSchema).min(1).max(1000),
  }),
  z.object({ type: z.literal('presence'), cursor: CursorSchema.nullable() }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type Cursor = z.infer<typeof CursorSchema>;

export interface Collaborator {
  siteId: string;
  userId: string;
  name: string;
  color: string;
  cursor: Cursor | null;
}

export type ServerMessage =
  | { type: 'joined'; siteId: string; role: string; seq: number; collaborators: Collaborator[] }
  | { type: 'snapshot'; seq: number; state: RgaSnapshot }
  | { type: 'sync'; seq: number; ops: Array<{ seq: number; siteId: string; op: Op }> }
  | { type: 'ops'; seq: number; from: string; userId: string; ops: Op[] }
  | { type: 'ack'; msgId?: string; seq: number }
  | ({ type: 'presence' } & Collaborator)
  | { type: 'presence_leave'; siteId: string }
  | { type: 'meta'; title: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
