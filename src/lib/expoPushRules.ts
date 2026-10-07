/**
 * Native push through the Expo push service (#2775, docs/mobile-push.md) — the
 * rules, with no Prisma and no network of their own, so a plain `node --test`
 * pins them (scripts/test/expo-push.test.mjs). The Prisma-aware half is
 * src/lib/expoPush.ts.
 *
 * Expo is the delivery hop, not a dependency: one HTTPS endpoint fronts FCM
 * (Android) and APNs (iOS), so nothing here knows which platform a token is on.
 * The server talks to it with plain `fetch` — the official SDK would add a
 * package for two POSTs.
 */

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** Expo's own ceilings: 100 messages per send, 1000 ids per receipt read. */
export const SEND_BATCH = 100;
export const RECEIPT_BATCH = 1000;

/** Same ceiling as PushSubscription (src/lib/webPush.ts). */
export const MAX_FAILURES = 5;

/** Same lifetime as a web push: a message older than this is not news. */
export const TTL_SECONDS = 12 * 60 * 60;

/** The Android channel the app creates at launch (apps/mobile/src/lib/push.ts). */
export const ANDROID_CHANNEL = 'messages';

/**
 * `ExponentPushToken[…]` (and the older `ExpoPushToken[…]`). The inside is an
 * opaque id — bounded and restricted to a safe alphabet, because the value is
 * stored, compared and sent back to Expo, never rendered.
 */
export const EXPO_TOKEN_RE = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,160}\]$/;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_TOKEN_RE.test(value);
}

export interface NativePushPayload {
  title: string;
  body: string;
  /** RELATIVE in-app path — the app resolves it against `host`. */
  url?: string;
  /** Collapse key: a burst in one thread replaces itself in the tray. */
  tag?: string;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { url?: string; host: string };
  sound: 'default';
  priority: 'high';
  ttl: number;
  channelId: string;
  tag?: string;
  collapseId?: string;
}

export interface TokenTarget {
  id: string;
  token: string;
  host: string;
}

/**
 * One message per token. `data.host` is the row's OWN host — the product the
 * app was signed in to when it registered — so a phone signed in to both
 * products opens the one this notification belongs to.
 */
export function buildMessages(targets: TokenTarget[], payload: NativePushPayload): ExpoMessage[] {
  return targets.map((t) => ({
    to: t.token,
    title: payload.title,
    body: payload.body,
    data: { ...(payload.url ? { url: payload.url } : {}), host: t.host },
    sound: 'default',
    priority: 'high',
    ttl: TTL_SECONDS,
    channelId: ANDROID_CHANNEL,
    ...(payload.tag ? { tag: payload.tag, collapseId: payload.tag } : {}),
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type ExpoResult = { status?: unknown; id?: unknown; details?: { error?: unknown } | null };

/**
 * What a send taught us about each row:
 *   - `delivered`: Expo accepted it (a ticket id, read back later as a receipt);
 *   - `gone`: Expo already knows the token is dead (`DeviceNotRegistered`) —
 *     deleted at once, the 404/410 of web push;
 *   - `failed`: anything else, counted towards {@link MAX_FAILURES}.
 *
 * A whole-request failure (network, 5xx, a malformed answer) lands every row of
 * that batch in `failed`; a ticket list shorter than the batch fails the rest.
 */
export interface SendOutcome {
  delivered: { rowId: string; ticketId: string }[];
  gone: string[];
  failed: string[];
}

export function classifyTickets(batch: TokenTarget[], response: unknown): SendOutcome {
  const out: SendOutcome = { delivered: [], gone: [], failed: [] };
  const data = (response as { data?: unknown } | null)?.data;
  const tickets: ExpoResult[] = Array.isArray(data) ? data : [];
  batch.forEach((row, i) => {
    const ticket = tickets[i];
    if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
      out.delivered.push({ rowId: row.id, ticketId: ticket.id });
    } else if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      out.gone.push(row.id);
    } else {
      out.failed.push(row.id);
    }
  });
  return out;
}

/**
 * The same split for a receipt read. A ticket with no receipt (not ready yet,
 * or already expired after 24h) is neither: absence is not evidence.
 */
export function classifyReceipts(
  tickets: { rowId: string; ticketId: string }[],
  response: unknown,
): { ok: string[]; gone: string[]; failed: string[] } {
  const out = { ok: [] as string[], gone: [] as string[], failed: [] as string[] };
  const data = (response as { data?: unknown } | null)?.data;
  const receipts = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, ExpoResult>) : {};
  for (const { rowId, ticketId } of tickets) {
    const r = receipts[ticketId];
    if (!r) continue;
    if (r.status === 'ok') out.ok.push(rowId);
    else if (r.details?.error === 'DeviceNotRegistered') out.gone.push(rowId);
    else out.failed.push(rowId);
  }
  return out;
}

export function expoHeaders(accessToken: string | null | undefined): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/**
 * Send to every target, {@link SEND_BATCH} at a time, and report per row.
 * Never throws: a batch whose request fails counts as failed for its rows.
 */
export async function sendBatches(
  targets: TokenTarget[],
  payload: NativePushPayload,
  opts: { fetch: Fetch; accessToken?: string | null },
): Promise<SendOutcome> {
  const total: SendOutcome = { delivered: [], gone: [], failed: [] };
  for (const batch of chunk(targets, SEND_BATCH)) {
    let response: unknown = null;
    try {
      const res = await opts.fetch(EXPO_SEND_URL, {
        method: 'POST',
        headers: expoHeaders(opts.accessToken),
        body: JSON.stringify(buildMessages(batch, payload)),
      });
      response = res.ok ? await res.json() : null;
    } catch {
      response = null;
    }
    const part = classifyTickets(batch, response);
    total.delivered.push(...part.delivered);
    total.gone.push(...part.gone);
    total.failed.push(...part.failed);
  }
  return total;
}

/** Read receipts for accepted tickets, {@link RECEIPT_BATCH} ids per request. Never throws. */
export async function readReceipts(
  tickets: { rowId: string; ticketId: string }[],
  opts: { fetch: Fetch; accessToken?: string | null },
): Promise<{ ok: string[]; gone: string[]; failed: string[] }> {
  const total = { ok: [] as string[], gone: [] as string[], failed: [] as string[] };
  for (const batch of chunk(tickets, RECEIPT_BATCH)) {
    try {
      const res = await opts.fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: expoHeaders(opts.accessToken),
        body: JSON.stringify({ ids: batch.map((t) => t.ticketId) }),
      });
      if (!res.ok) continue;
      const part = classifyReceipts(batch, await res.json());
      total.ok.push(...part.ok);
      total.gone.push(...part.gone);
      total.failed.push(...part.failed);
    } catch {
      // A receipt read that fails tells us nothing about the tokens.
    }
  }
  return total;
}
