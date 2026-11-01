// The record a partner's support question is about (docs/affiliate-module.md,
// #3353). Pure: the format only. Whether the record is the sender's own is
// src/lib/affiliateRecordRef.ts, on the server.
//
// A question changes nothing: it is a support message with a pointer, and any
// correction still goes through the admin and the one payment writer.

export const RECORD_KINDS = ['commission', 'customer'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const PREFIX = 'affiliate';
// cuid()s are lower-case alphanumerics; anything else is not one of our ids.
const ID_RE = /^[a-z0-9]{1,40}$/;

export function recordRef(kind: RecordKind, id: string): string {
  return `${PREFIX}:${kind}:${id}`;
}

/** `{ kind, id }` for a well-formed reference, null for anything else. */
export function parseRecordRef(raw: unknown): { kind: RecordKind; id: string } | null {
  if (typeof raw !== 'string') return null;
  const [prefix, kind, id, ...rest] = raw.split(':');
  if (prefix !== PREFIX || rest.length || !(RECORD_KINDS as readonly string[]).includes(kind) || !ID_RE.test(id ?? '')) return null;
  return { kind: kind as RecordKind, id };
}

/** What the screens show about a referenced row (src/lib/affiliateRecordRef.ts fills it). */
export interface RecordSummary {
  kind: RecordKind;
  customerRef: string;
  /** Commission only: its amount, currency and status. */
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
}
