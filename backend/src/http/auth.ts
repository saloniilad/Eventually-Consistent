import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ name: user.name, email: user.email }, secret, {
    subject: user.id,
    expiresIn: '7d',
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string, secret: string): AuthUser | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof p === 'string' || !p.sub) return null;
    return { id: p.sub, name: String(p.name ?? ''), email: String(p.email ?? '') };
  } catch {
    return null;
  }
}
