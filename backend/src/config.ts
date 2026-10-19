export interface Config {
  port: number;
  databaseUrl: string | null;
  jwtSecret: string;
  corsOrigins: string[] | '*';
  snapshotEvery: number;
  maxDocChars: number;
  authRateLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? 'dev-only-secret-change-me';
  if (prod && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET must be set (>= 32 chars) in production');
  }
  const origins = (env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim());
  return {
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL || null,
    jwtSecret,
    corsOrigins: origins.includes('*') ? '*' : origins,
    snapshotEvery: Number(env.SNAPSHOT_EVERY ?? 200),
    maxDocChars: Number(env.MAX_DOC_CHARS ?? 500_000),
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 50),
    logLevel: (env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  };
}
