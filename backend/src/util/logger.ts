const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

let current: Level = 'info';
export const setLogLevel = (l: Level): void => {
  current = l;
};

function emit(level: Exclude<Level, 'silent'>, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};
