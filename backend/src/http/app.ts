import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config';
import { rebuild } from '../docs/replay';
import type { SessionManager } from '../docs/manager';
import { ProtocolError } from '../docs/session';
import { DuplicateError, ROLE_RANK, Role, Store } from '../store/types';
import { lineDiff } from '../util/diff';
import { log } from '../util/logger';
import { AuthUser, signToken, verifyToken } from './auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      role?: Role;
    }
  }
}

export interface AppContext {
  config: Config;
  store: Store;
  sessions: SessionManager;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return r.data;
}

const Credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});
const Register = Credentials.extend({ name: z.string().trim().min(1).max(80) });
const Title = z.object({ title: z.string().trim().min(1).max(200) });
const NewDoc = z.object({ title: z.string().trim().min(1).max(200).default('Untitled') });
const Share = z.object({ email: z.string().email(), role: z.enum(['editor', 'viewer']) });

export function createApp(ctx: AppContext): express.Express {
  const { store, config, sessions } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins === '*' ? true : config.corsOrigins }));
  app.use(express.json({ limit: '200kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ---------- auth ----------
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post(
    '/api/auth/register',
    authLimiter,
    wrap(async (req, res) => {
      const body = parse(Register, req.body);
      const passwordHash = await bcrypt.hash(body.password, 10);
      try {
        const user = await store.createUser({ email: body.email, name: body.name, passwordHash });
        const u = { id: user.id, name: user.name, email: user.email };
        res.status(201).json({ token: signToken(u, config.jwtSecret), user: u });
      } catch (err) {
        if (err instanceof DuplicateError) throw new HttpError(409, 'email already registered');
        throw err;
      }
    }),
  );

  app.post(
    '/api/auth/login',
    authLimiter,
    wrap(async (req, res) => {
      const body = parse(Credentials, req.body);
      const user = await store.findUserByEmail(body.email);
      const ok = user ? await bcrypt.compare(body.password, user.passwordHash) : false;
      if (!user || !ok) throw new HttpError(401, 'invalid email or password');
      const u = { id: user.id, name: user.name, email: user.email };
      res.json({ token: signToken(u, config.jwtSecret), user: u });
    }),
  );

  const requireAuth: RequestHandler = (req, _res, next) => {
    const h = req.headers.authorization ?? '';
    const user = h.startsWith('Bearer ') ? verifyToken(h.slice(7), config.jwtSecret) : null;
    if (!user) return next(new HttpError(401, 'authentication required'));
    req.user = user;
    next();
  };

  const requireRole =
    (min: Role): RequestHandler =>
    (req, _res, next) => {
      const id = String(req.params.id);
      if (!UUID.test(id)) return next(new HttpError(404, 'document not found'));
      store
        .getRole(id, (req.user as AuthUser).id)
        .then((role) => {
          // 404 (not 403) for non-members so document ids are not discoverable.
          if (!role) return next(new HttpError(404, 'document not found'));
          if (ROLE_RANK[role] < ROLE_RANK[min])
            return next(new HttpError(403, 'insufficient permissions'));
          req.role = role;
          next();
        })
        .catch(next);
    };

  app.get(
    '/api/auth/me',
    requireAuth,
    wrap(async (req, res) => {
      res.json({ user: req.user });
    }),
  );

  // ---------- documents ----------
  app.get(
    '/api/docs',
    requireAuth,
    wrap(async (req, res) => {
      res.json({ documents: await store.listDocuments((req.user as AuthUser).id) });
    }),
  );

  app.post(
    '/api/docs',
    requireAuth,
    wrap(async (req, res) => {
      const { title } = parse(NewDoc, req.body ?? {});
      const doc = await store.createDocument((req.user as AuthUser).id, title);
      res.status(201).json({ document: { ...doc, role: 'owner' } });
    }),
  );

  app.get(
    '/api/docs/:id',
    requireAuth,
    requireRole('viewer'),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const doc = await store.getDocument(id);
      const session = await sessions.acquire(id);
      try {
        res.json({ document: doc, role: req.role, text: session.text, seq: session.headSeq });
      } finally {
        void sessions.release(id);
      }
    }),
  );

  app.patch(
    '/api/docs/:id',
    requireAuth,
    requireRole('editor'),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const { title } = parse(Title, req.body);
      await store.renameDocument(id, title);
      const live = sessions.peek(id);
      if (live) (await live).broadcast({ type: 'meta', title });
      res.json({ ok: true, title });
    }),
  );

  app.post(
    '/api/docs/:id/members',
    requireAuth,
    requireRole('owner'),
    wrap(async (req, res) => {
      const body = parse(Share, req.body);
      const target = await store.findUserByEmail(body.email);
      if (!target) throw new HttpError(404, 'no user with that email');
      if ((await store.getRole(String(req.params.id), target.id)) === 'owner') {
        throw new HttpError(400, 'cannot change the owner role');
      }
      await store.setMember(String(req.params.id), target.id, body.role);
      res.json({ ok: true, userId: target.id, role: body.role });
    }),
  );

  // ---------- version history / time travel ----------
  const seqParam = (v: unknown, name: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new HttpError(400, `${name} must be a non-negative integer`);
    return n;
  };

  app.get(
    '/api/docs/:id/versions',
    requireAuth,
    requireRole('viewer'),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const [head, snapshots] = await Promise.all([store.getHeadSeq(id), store.listSnapshots(id)]);
      res.json({ head, snapshots });
    }),
  );

  app.get(
    '/api/docs/:id/versions/:seq',
    requireAuth,
    requireRole('viewer'),
    wrap(async (req, res) => {
      const seq = seqParam(req.params.seq, 'seq');
      const {
        rga,
        seq: actual,
        snapshotSeq,
        replayed,
      } = await rebuild(store, String(req.params.id), seq);
      res.json({ requested: seq, seq: actual, text: rga.text(), snapshotSeq, replayed });
    }),
  );

  app.get(
    '/api/docs/:id/compare',
    requireAuth,
    requireRole('viewer'),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const from = seqParam(req.query.from, 'from');
      const to =
        req.query.to === undefined ? await store.getHeadSeq(id) : seqParam(req.query.to, 'to');
      const [a, b] = await Promise.all([rebuild(store, id, from), rebuild(store, id, to)]);
      res.json({
        from: { seq: from, text: a.rga.text() },
        to: { seq: to, text: b.rga.text() },
        diff: lineDiff(a.rga.text(), b.rga.text()),
      });
    }),
  );

  app.post(
    '/api/docs/:id/versions/:seq/restore',
    requireAuth,
    requireRole('editor'),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const seq = seqParam(req.params.seq, 'seq');
      const { rga } = await rebuild(store, id, seq);
      const session = await sessions.acquire(id);
      try {
        // Restoring is a *new* edit on top of history, never a rewrite of it,
        // so collaborators' live replicas just receive normal ops.
        const result = await session.replaceText((req.user as AuthUser).id, rga.text());
        res.json({ ok: true, restoredFrom: seq, ...result, seq: session.headSeq });
      } finally {
        void sessions.release(id);
      }
    }),
  );

  // ---------- errors ----------
  app.use((_req, _res, next) => next(new HttpError(404, 'not found')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ProtocolError)
      return void res.status(400).json({ error: err.message, code: err.code });
    if (err instanceof SyntaxError) return void res.status(400).json({ error: 'invalid JSON' });
    log.error('unhandled http error', { err: String(err) });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
