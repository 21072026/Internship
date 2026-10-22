// The roster feed's configuration layer (#1964, story #1963): what a feed IS —
// where its file comes from, how its columns map to ours, and when it runs.
//
// The engine that runs a feed is `rosterIngest.ts` (#1965); this module only
// answers "is this a feed we would agree to run?", and it answers it the same
// way for the admin route and for anything that later edits a feed. Pure:
// no Prisma, no secret handling (the sealing lives in the route), so every rule
// below is pinned by `e2e/roster-feed.unit.spec.ts` without a database.
//
// THE SCHEDULE. A feed's `cronExpression` is a standard five-field cron
// expression (minute hour day-of-month month day-of-week), stored and evaluated
// in UTC. The console renders it in the admin's own zone; the stored string
// never moves with daylight saving. The parser here is deliberately small —
// numbers, `*`, ranges, steps and lists, no names and no `L`/`W`/`#` — because
// a feed that runs "on the last weekday" is not a thing anyone has asked for,
// and every extension is one more way for "when does this run?" to be
// misread. `nextCronRun()` is what the console shows and `cronMatches()` is what
// a scheduler asks; they share one parser so they cannot disagree.

// ── Vocabulary (re-exported by rosterIngest.ts) ──────────────────────────────

export const ROSTER_TRANSPORTS = ['HTTPS', 'SFTP'] as const;
export type RosterTransport = (typeof ROSTER_TRANSPORTS)[number];

/**
 * Which column identifies a person.
 *
 * EMAIL is the obvious choice and the wrong one for any tenant whose people
 * ever change their address: with e-mail as the key, one person renaming their
 * mailbox is indistinguishable from a leaver plus a joiner — and #1966 would
 * deprovision the leaver. EXTERNAL_ID (the HR system's own personnel number) is
 * what makes an e-mail change readable as an update.
 */
export const ROSTER_KEY_FIELDS = ['EMAIL', 'EXTERNAL_ID'] as const;
export type RosterKeyField = (typeof ROSTER_KEY_FIELDS)[number];

/** Profile columns a feed may carry, beyond the identity ones. */
export const ROSTER_PROFILE_FIELDS = ['fullName', 'phone', 'university', 'department'] as const;
export type RosterProfileField = (typeof ROSTER_PROFILE_FIELDS)[number];

/** Our field name → the header the tenant's export happens to use. */
export interface RosterColumnMap {
  email?: string;
  externalId?: string;
  fullName?: string;
  phone?: string;
  university?: string;
  department?: string;
}

/** The `seal()` purpose for a feed's secret — one key per purpose (secretBox.ts). */
export const ROSTER_FEED_SECRET_PURPOSE = 'roster-feed-secret';

/** Every field a column map may name, identity columns first. */
export const ROSTER_MAPPABLE_FIELDS = ['email', 'externalId', ...ROSTER_PROFILE_FIELDS] as const;
export type RosterMappableField = (typeof ROSTER_MAPPABLE_FIELDS)[number];

export const ROSTER_FEED_LIMITS = {
  name: 120,
  url: 2048,
  host: 255,
  username: 191,
  path: 1024,
  fingerprint: 191,
  envVar: 120,
  cron: 120,
  column: 191,
  secret: 16_384, // a PEM private key fits with room to spare
  chunkMin: 10,
  chunkMax: 1000,
  maxGraceDays: 30,
  maxMinRowCount: 1_000_000,
} as const;

/** The valves' defaults — the schema's DB-side defaults, in one place for the API. */
export const ROSTER_DEPROVISION_DEFAULTS = {
  maxDeactivatePercent: 10,
  minRowCount: 1,
  deprovisionGraceDays: 1,
} as const;

// ── Cron ─────────────────────────────────────────────────────────────────────

interface CronField {
  min: number;
  max: number;
}

const CRON_FIELDS: readonly CronField[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week, 0 and 7 both Sunday
];

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Both day fields restricted → classic cron OR semantics between them. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(raw: string, field: CronField): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = field.min;
    let hi = field.max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map((n) => Number.parseInt(n, 10));
      lo = a;
      hi = b ?? (m[2] ? field.max : a);
    }
    const step = m[2] ? Number.parseInt(m[2], 10) : 1;
    if (step < 1 || lo < field.min || hi > field.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a five-field cron expression, or null when it is not one we accept. */
export function parseCron(expression: string): ParsedCron | null {
  if (typeof expression !== 'string' || expression.length > ROSTER_FEED_LIMITS.cron) return null;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i]));
  if (sets.some((s) => s === null)) return null;
  const [minutes, hours, daysOfMonth, months, dowRaw] = sets as Set<number>[];
  const daysOfWeek = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

function matchesParsed(cron: ParsedCron, at: Date): boolean {
  if (!cron.minutes.has(at.getUTCMinutes())) return false;
  if (!cron.hours.has(at.getUTCHours())) return false;
  if (!cron.months.has(at.getUTCMonth() + 1)) return false;
  const dom = cron.daysOfMonth.has(at.getUTCDate());
  const dow = cron.daysOfWeek.has(at.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Does the expression fire in the UTC minute containing `at`? */
export function cronMatches(expression: string, at: Date): boolean {
  const cron = parseCron(expression);
  return cron ? matchesParsed(cron, at) : false;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Far enough to find `0 0 29 2 *` from any starting point. */
const NEXT_RUN_HORIZON_DAYS = 366 * 5;

/**
 * The first UTC minute strictly after `from` at which the expression fires, or
 * null for an invalid expression (or one that never fires, e.g. `0 0 31 2 *`).
 * Walks whole days that cannot match before walking minutes, so the worst case
 * stays a few thousand steps.
 */
export function nextCronRun(expression: string, from: Date): Date | null {
  const cron = parseCron(expression);
  if (!cron) return null;
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = t + NEXT_RUN_HORIZON_DAYS * DAY;
  while (t < end) {
    const at = new Date(t);
    const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    const probe = new Date(dayStart);
    const monthOk = cron.months.has(probe.getUTCMonth() + 1);
    const dom = cron.daysOfMonth.has(probe.getUTCDate());
    const dow = cron.daysOfWeek.has(probe.getUTCDay());
    const dayOk = monthOk && (cron.domRestricted && cron.dowRestricted ? dom || dow : dom && dow);
    if (!dayOk) {
      t = dayStart + DAY;
      continue;
    }
    if (matchesParsed(cron, at)) return at;
    t += MINUTE;
  }
  return null;
}

// ── Columns ──────────────────────────────────────────────────────────────────

export interface ResolvedColumns {
  /** Our field → its index in the header, for every mapped column that exists. */
  indexes: Partial<Record<RosterMappableField, number>>;
  /** Our fields whose mapped header is not in the file. */
  missing: RosterMappableField[];
}

/**
 * Where each mapped column sits in a header row. Matching is the engine's —
 * trimmed and case-insensitive (`headerIndex` in importPreview.ts) — so the
 * console's "this column was not found" and the run's own reading agree.
 */
export function resolveColumns(header: string[], columnMap: RosterColumnMap): ResolvedColumns {
  const normalised = header.map((h) => h.trim().toLowerCase());
  const indexes: ResolvedColumns['indexes'] = {};
  const missing: RosterMappableField[] = [];
  for (const field of ROSTER_MAPPABLE_FIELDS) {
    const column = columnMap[field];
    if (!column || !column.trim()) continue;
    const index = normalised.indexOf(column.trim().toLowerCase());
    if (index < 0) missing.push(field);
    else indexes[field] = index;
  }
  return { indexes, missing };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** The admin-editable part of a feed — everything except the secret's value. */
export interface RosterFeedInput {
  name: string;
  transport: RosterTransport;
  enabled: boolean;
  url: string | null;
  sftpHost: string | null;
  sftpPort: number | null;
  sftpUsername: string | null;
  sftpPath: string | null;
  sftpHostKeyFingerprint: string | null;
  credentialEnvVar: string | null;
  delimiter: string | null;
  keyField: RosterKeyField;
  columnMap: RosterColumnMap;
  authoritative: boolean;
  chunkSize: number | null;
  cronExpression: string | null;
  /** Deprovisioning and its valves (#1966, docs/roster-feeds.md). */
  deprovision: boolean;
  maxDeactivatePercent: number;
  minRowCount: number;
  deprovisionGraceDays: number;
}

export type RosterFeedErrorCode =
  | 'required'
  | 'too_long'
  | 'invalid'
  | 'invalid_cron'
  | 'not_https'
  | 'blocked'
  | 'missing_email_column'
  | 'missing_key_column'
  | 'unknown_field';

export interface RosterFeedError {
  field: string;
  code: RosterFeedErrorCode;
}

export type RosterFeedValidation =
  | { ok: true; value: RosterFeedInput }
  | { ok: false; errors: RosterFeedError[] };

const DELIMITERS = [',', ';', '\t', '|'];
/** POSIX-ish env var name: what `process.env[...]` can actually hold. */
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
/** A hostname or an IP literal — no scheme, no path, no credentials. */
const HOST_RE = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/;
const FINGERPRINT_RE = /^(?:sha256:[A-Za-z0-9+/=]{20,}|md5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2}|[0-9A-Fa-f:]{32,})$/i;

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

/**
 * Normalise and check a feed's configuration. Every problem is reported at
 * once (one error per field), so the console can mark all of them in one pass.
 *
 * What it refuses, and why:
 *   - a cron expression we cannot parse — a schedule that silently never fires
 *     is worse than a refusal;
 *   - a transport without its own fields (HTTPS: an https URL; SFTP: host,
 *     username, path and the PINNED host key — no fingerprint, no feed);
 *   - a column map with no `email` mapping (every account is keyed on one) or,
 *     for an EXTERNAL_ID feed, no `externalId` mapping;
 *   - a column map naming a field we do not have — it would be ignored, and
 *     an ignored mapping reads as a working one.
 *
 * SSRF is NOT decided here: whether a URL resolves to a public address is
 * `assertPublicHttpsUrl()`'s job, at save time in the route and again before
 * every fetch.
 */
export function validateFeedConfig(
  raw: unknown,
  options: { allowInsecureLoopback?: boolean } = {},
): RosterFeedValidation {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: RosterFeedError[] = [];
  const fail = (field: string, code: RosterFeedErrorCode) => errors.push({ field, code });
  const L = ROSTER_FEED_LIMITS;

  const name = str(input.name);
  if (!name) fail('name', 'required');
  else if (name.length > L.name) fail('name', 'too_long');

  const transport = (input.transport ?? 'HTTPS') as RosterTransport;
  if (!ROSTER_TRANSPORTS.includes(transport)) fail('transport', 'invalid');

  const keyField = (input.keyField ?? 'EMAIL') as RosterKeyField;
  if (!ROSTER_KEY_FIELDS.includes(keyField)) fail('keyField', 'invalid');

  // ── Transport-specific fields ──
  const url = str(input.url);
  const sftpHost = str(input.sftpHost);
  const sftpUsername = str(input.sftpUsername);
  const sftpPath = str(input.sftpPath);
  const sftpHostKeyFingerprint = str(input.sftpHostKeyFingerprint);
  let sftpPort: number | null = null;

  if (transport === 'HTTPS') {
    if (!url) fail('url', 'required');
    else if (url.length > L.url) fail('url', 'too_long');
    else {
      try {
        const parsed = new URL(url);
        // The e2e switch admits exactly `http://127.0.0.1:…` (rosterIngest.ts).
        const stub = options.allowInsecureLoopback && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
        if (parsed.protocol !== 'https:' && !stub) fail('url', 'not_https');
        else if (parsed.username || parsed.password) fail('url', 'invalid');
      } catch {
        fail('url', 'invalid');
      }
    }
  } else if (transport === 'SFTP') {
    if (!sftpHost) fail('sftpHost', 'required');
    else if (sftpHost.length > L.host) fail('sftpHost', 'too_long');
    else if (!HOST_RE.test(sftpHost)) fail('sftpHost', 'invalid');
    if (!sftpUsername) fail('sftpUsername', 'required');
    else if (sftpUsername.length > L.username) fail('sftpUsername', 'too_long');
    if (!sftpPath) fail('sftpPath', 'required');
    else if (sftpPath.length > L.path) fail('sftpPath', 'too_long');
    // The pin is a requirement, not a nicety: without it the first connection
    // trusts whoever answers, and hands them the customer's credential.
    if (!sftpHostKeyFingerprint) fail('sftpHostKeyFingerprint', 'required');
    else if (sftpHostKeyFingerprint.length > L.fingerprint) fail('sftpHostKeyFingerprint', 'too_long');
    else if (!FINGERPRINT_RE.test(sftpHostKeyFingerprint)) fail('sftpHostKeyFingerprint', 'invalid');
    if (input.sftpPort !== undefined && input.sftpPort !== null && input.sftpPort !== '') {
      const port = Number(input.sftpPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('sftpPort', 'invalid');
      else sftpPort = port;
    }
  }

  const credentialEnvVar = str(input.credentialEnvVar);
  if (credentialEnvVar) {
    if (credentialEnvVar.length > L.envVar) fail('credentialEnvVar', 'too_long');
    else if (!ENV_VAR_RE.test(credentialEnvVar)) fail('credentialEnvVar', 'invalid');
  }

  // Not trimmed: a tab is a delimiter.
  const delimiter = typeof input.delimiter === 'string' && input.delimiter !== '' ? input.delimiter : null;
  if (delimiter !== null && !DELIMITERS.includes(delimiter)) fail('delimiter', 'invalid');

  // ── Column map ──
  const columnMap: RosterColumnMap = {};
  const rawMap = input.columnMap;
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    fail('columnMap', 'missing_email_column');
  } else {
    for (const [field, column] of Object.entries(rawMap as Record<string, unknown>)) {
      if (!(ROSTER_MAPPABLE_FIELDS as readonly string[]).includes(field)) {
        fail(`columnMap.${field}`, 'unknown_field');
        continue;
      }
      const c = str(column);
      if (!c) continue;
      if (c.length > L.column) fail(`columnMap.${field}`, 'too_long');
      else columnMap[field as RosterMappableField] = c;
    }
    if (!columnMap.email) fail('columnMap.email', 'missing_email_column');
    if (keyField === 'EXTERNAL_ID' && !columnMap.externalId) fail('columnMap.externalId', 'missing_key_column');
  }

  // ── Schedule ──
  const cronExpression = str(input.cronExpression);
  if (cronExpression && !isValidCron(cronExpression)) fail('cronExpression', 'invalid_cron');

  let chunkSize: number | null = null;
  if (input.chunkSize !== undefined && input.chunkSize !== null && input.chunkSize !== '') {
    const n = Number(input.chunkSize);
    if (!Number.isInteger(n) || n < L.chunkMin || n > L.chunkMax) fail('chunkSize', 'invalid');
    else chunkSize = n;
  }

  // ── Deprovisioning valves (#1966) ──
  const int = (field: keyof typeof ROSTER_DEPROVISION_DEFAULTS, min: number, max: number): number => {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') return ROSTER_DEPROVISION_DEFAULTS[field];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      fail(field, 'invalid');
      return ROSTER_DEPROVISION_DEFAULTS[field];
    }
    return n;
  };
  const maxDeactivatePercent = int('maxDeactivatePercent', 0, 100);
  const minRowCount = int('minRowCount', 0, L.maxMinRowCount);
  const deprovisionGraceDays = int('deprovisionGraceDays', 0, L.maxGraceDays);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name!,
      transport,
      enabled: input.enabled === true,
      url: transport === 'HTTPS' ? url : null,
      sftpHost: transport === 'SFTP' ? sftpHost : null,
      sftpPort: transport === 'SFTP' ? sftpPort : null,
      sftpUsername: transport === 'SFTP' ? sftpUsername : null,
      sftpPath: transport === 'SFTP' ? sftpPath : null,
      sftpHostKeyFingerprint: transport === 'SFTP' ? sftpHostKeyFingerprint : null,
      credentialEnvVar,
      delimiter,
      keyField,
      columnMap,
      authoritative: input.authoritative === true,
      chunkSize,
      cronExpression: cronExpression ? cronExpression.replace(/\s+/g, ' ') : null,
      deprovision: input.deprovision === true,
      maxDeactivatePercent,
      minRowCount,
      deprovisionGraceDays,
    },
  };
}

// ── Scheduling (#1967) ───────────────────────────────────────────────────────

/** Three FAILED runs in a row pause a feed (`enabled = false` + `pausedReason`). */
export const ROSTER_FAILURE_PAUSE_THRESHOLD = 3;

/**
 * How long a claim holds a feed. Longer than the engine's stale-run window
 * (`DEFAULT_STALE_RUN_MS`, 30 minutes), so a claim never lapses under a run the
 * engine still considers alive.
 */
export const ROSTER_CLAIM_MS = 35 * 60 * 1000;

export interface ScheduledFeed {
  enabled: boolean;
  cronExpression: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
}

/** When the feed is next due, or null when it has no (valid) schedule. */
export function nextFeedRun(feed: ScheduledFeed): Date | null {
  if (!feed.cronExpression) return null;
  return nextCronRun(feed.cronExpression, feed.lastRunAt ?? feed.createdAt);
}

/**
 * Is the feed due at `now`? A feed is due once the first scheduled minute after
 * its last run (or its creation) has passed — so a waker that missed a tick
 * (a redeploy, a slow run) catches up exactly once rather than once per missed
 * slot, and a paused feed is never due.
 */
export function isFeedDue(feed: ScheduledFeed, now: Date): boolean {
  if (!feed.enabled) return false;
  const next = nextFeedRun(feed);
  return next !== null && next.getTime() <= now.getTime();
}

export function shouldPauseFeed(consecutiveFailures: number): boolean {
  return consecutiveFailures >= ROSTER_FAILURE_PAUSE_THRESHOLD;
}
