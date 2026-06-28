// Minimal leveled structured logger. Threshold via LOG_LEVEL env
// (debug | info | warning | error); defaults to info.
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 20;

function emit(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = { level, message, ...(context || {}) };
  const out = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
  // Timestamp added by the platform; keep the payload structured and greppable.
  out(`[${level.toUpperCase()}] ${message}`, JSON.stringify(line));
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warning: (m: string, c?: Record<string, unknown>) => emit('warning', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};
