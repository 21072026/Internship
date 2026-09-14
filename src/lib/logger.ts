// Minimal leveled structured logger. Threshold via LOG_LEVEL env
// (debug | info | warning | error); defaults to info.
//
// Every line is stamped with the correlation ids of the request that produced it
// (#1601) — `requestId` from `src/lib/requestContext.ts` and `orgId` from
// `src/lib/orgContext.ts` — so one log line can be traced back to the one
// request a user complained about. Both come through the dependency-free seams
// (`requestId.ts` / `tenantAmbient.ts`) rather than by importing those
// server-only engines, because this module is imported by ~25 others and must
// not drag `node:async_hooks` into any bundle. Outside a request (cron ticks,
// deploy scripts) there is nothing bound and the fields are simply absent.
import { ambientRequestId } from './requestId';
import { ambientOrgId } from './tenantAmbient';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 20;

// The ids for the request in flight, if any. A caller-supplied context still
// wins (it is spread after this), so a call that deliberately logs about
// *another* request or org is not overwritten.
function ambientContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const requestId = ambientRequestId();
  if (requestId) out.requestId = requestId;
  const orgId = ambientOrgId();
  if (orgId) out.orgId = orgId;
  return out;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = { level, message, ...ambientContext(), ...(context || {}) };
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
