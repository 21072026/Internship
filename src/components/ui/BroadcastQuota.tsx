'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

/**
 * The broadcast quota, as the two composers see it (#1754).
 *
 * ONE component for both surfaces on purpose: the announcement composer and the
 * newsletter composer are metered by the same band against the same month, so a
 * second copy of "used X of Y" is a second place for the sentence to drift out
 * of step with the server's arithmetic.
 *
 * The refusal is rendered HERE from `code` + the figures rather than printed
 * from the response body: a server-authored message is never shown verbatim
 * (see src/lib/apiErrorMessage.ts), and the numbers are exactly what makes the
 * block actionable — how many you have used, of what, and when it resets.
 */

export interface BroadcastQuotaStatus {
  /** null = unlimited band; `used` is then null too and nothing is counted. */
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetsAt: string;
  plan: string | null;
}

/** The 403 body `broadcastQuotaError()` returns. */
export interface BroadcastQuotaRefusal {
  code: string;
  limit: number | null;
  used: number;
  requested: number;
  remaining: number | null;
  resetsAt: string;
}

export const BROADCAST_QUOTA_CODE = 'broadcast_quota_exceeded';

/** Is this parsed error body a broadcast-quota refusal? */
export function isBroadcastQuotaRefusal(body: unknown): body is BroadcastQuotaRefusal {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === BROADCAST_QUOTA_CODE;
}

/**
 * Read the meter, and re-read it after a send so the line an admin looks at is
 * never one broadcast out of date. A failed read leaves it null, which renders
 * nothing at all — the band is a guard-rail, and a composer must not become
 * unusable because a status call did not answer.
 */
export function useBroadcastQuota() {
  const [quota, setQuota] = useState<BroadcastQuotaStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/broadcast-quota');
      if (!res.ok) return;
      setQuota((await res.json()) as BroadcastQuotaStatus);
    } catch {
      // Non-fatal by design; see above.
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { quota, refreshQuota: refresh };
}

/** "Broadcast e-mail: 120 of 250 recipients used this month." */
export function BroadcastQuotaLine({ quota }: { quota: BroadcastQuotaStatus | null }) {
  const t = useT();
  const locale = useLocale();
  if (!quota) return null;

  const text =
    quota.limit == null || quota.used == null
      ? t.broadcastQuota.unlimited
      : t.broadcastQuota.usage
          .replace('{used}', String(quota.used))
          .replace('{limit}', String(quota.limit))
          .replace('{date}', formatDate(quota.resetsAt, locale));

  return (
    <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="broadcast-quota-line">
      {text}
    </p>
  );
}

/**
 * The localized refusal sentence for a 403 body. Returns null when the body is
 * not a quota refusal, so a caller can fall through to its own error handling.
 */
export function useBroadcastQuotaMessage() {
  const t = useT();
  const locale = useLocale();
  return useCallback(
    (body: unknown): string | null => {
      if (!isBroadcastQuotaRefusal(body)) return null;
      return t.broadcastQuota.blocked
        .replace('{requested}', String(body.requested))
        .replace('{remaining}', String(body.remaining ?? 0))
        .replace('{limit}', String(body.limit ?? 0))
        .replace('{used}', String(body.used))
        .replace('{date}', formatDate(body.resetsAt, locale));
    },
    [t, locale],
  );
}
