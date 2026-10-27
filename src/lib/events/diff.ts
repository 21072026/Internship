// THE before/after diff of a configuration write (#1699). One implementation in
// the tree: the organization PATCH, the webhook and API-key routes and the
// settings writer (#1623) all pass their own field policy into `redactedDiff()`
// — none computes a diff of its own, none masks a value of its own.
//
// THE POLICY IS EXPLICIT AND FAILS CLOSED
//   A spec names every field the caller knows: `record` keeps both values,
//   `redact` keeps only THAT the field changed (plus a short fingerprint of
//   each side), `ignore` drops it (`updatedAt` and friends). A field the spec
//   does not name is REDACTED — a column added to the model next year cannot
//   leak into the audit trail because nobody remembered this file.
//
//   On top of the spec, a field whose NAME ends in a secret word (`…Secret`,
//   `…Certificate`, `…Token`, `hashedKey`, `…Password`, …) is redacted even if
//   a spec says `record`. A spec typo must not be the only thing between a
//   signing certificate and a tenant's SIEM.
//
// THE FINGERPRINT
//   The first 8 hex characters of a SHA-256 over the value. It answers the one
//   question an auditor asks of a redacted field — "did it change to something
//   different, or was it re-saved?" — without being the value. Two different
//   certificates have different fingerprints; the same one re-pasted has the
//   same. 32 bits are no protection for a guessable value, which is why a
//   low-entropy personal field (an e-mail address) is still worth redacting:
//   the fingerprint stops a casual reader, not a determined one.
//
// Values are JSON scalars. An array or object is compared and recorded as its
// canonical JSON; a recorded string is cut at RECORDED_VALUE_MAX characters (a
// brand logo may be an inline `data:image`, which would otherwise put a whole
// image into every audit row). Server and tests only (node:crypto).

import { createHash } from 'node:crypto';

export type FieldPolicy = 'record' | 'redact' | 'ignore';

/** Field → policy. A field the spec does not name is redacted. */
export type DiffSpec = Readonly<Record<string, FieldPolicy>>;

export type DiffValue = string | number | boolean | null;

export interface FieldChange {
  field: string;
  /** The value before, `REDACTED` for a redacted field that had one, null when there was none. */
  from: DiffValue;
  to: DiffValue;
  /** Present (and true) only on a redacted field. */
  redacted?: true;
  /** First 8 hex of SHA-256 of the old value; null when there was none. Redacted fields only. */
  fromFingerprint?: string | null;
  toFingerprint?: string | null;
}

export const REDACTED = '[redacted]';
export const RECORDED_VALUE_MAX = 200;

// A field named like one of these is a credential whatever a spec says.
const SECRET_SHAPED = /(secret|password|passwd|passphrase|token|certificate|privatekey|hashedkey|apikey|credentials?|hash)$/i;

export function isSecretShaped(field: string): boolean {
  return SECRET_SHAPED.test(field);
}

/** The policy a field is diffed under — the spec's, tightened by the secret-name rule. */
export function policyFor(field: string, spec: DiffSpec): FieldPolicy {
  const declared = Object.prototype.hasOwnProperty.call(spec, field) ? spec[field] : 'redact';
  if (declared === 'record' && isSecretShaped(field)) return 'redact';
  return declared;
}

function canonical(value: unknown): DiffValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function fingerprint(value: DiffValue): string | null {
  if (value === null) return null;
  return createHash('sha256').update(`${typeof value}:${String(value)}`).digest('hex').slice(0, 8);
}

function clip(value: DiffValue): DiffValue {
  return typeof value === 'string' && value.length > RECORDED_VALUE_MAX ? `${value.slice(0, RECORDED_VALUE_MAX)}…` : value;
}

type Row = Readonly<Record<string, unknown>> | null | undefined;

/**
 * The fields that differ between `before` and `after`, in a stable (sorted)
 * order, each recorded or redacted per `spec`. A null/undefined `before` is a
 * creation, a null/undefined `after` a deletion. Only the fields present in
 * either row are compared, so pass the rows as they are (or the subset a
 * request may touch) — not a partial update payload against a whole row.
 */
export function redactedDiff(before: Row, after: Row, spec: DiffSpec): FieldChange[] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const policy = policyFor(field, spec);
    if (policy === 'ignore') continue;
    const from = canonical(before?.[field]);
    const to = canonical(after?.[field]);
    if (from === to) continue;
    if (policy === 'record') {
      changes.push({ field, from: clip(from), to: clip(to) });
    } else {
      changes.push({
        field,
        from: from === null ? null : REDACTED,
        to: to === null ? null : REDACTED,
        redacted: true,
        fromFingerprint: fingerprint(from),
        toFingerprint: fingerprint(to),
      });
    }
  }
  return changes;
}

// ── The specs of the records this task audits ────────────────────────────────
// One per model, next to the helper so the policy of every config write is
// readable in one place. The settings catalogue derives its own (#1623).

/** Organization: plan, identity, branding and SSO. */
export const ORGANIZATION_DIFF_SPEC: DiffSpec = {
  name: 'record',
  slug: 'record',
  plan: 'record',
  vertical: 'record',
  brandName: 'record',
  brandColor: 'record',
  brandLogoUrl: 'record',
  brandTileColor: 'record',
  brandAccent: 'record',
  brandPalette: 'record',
  // Personal data (an address a person reads), not configuration: redacted.
  supportEmail: 'redact',
  ssoEnabled: 'record',
  ssoProvider: 'record',
  ssoIssuer: 'record',
  ssoEntryPoint: 'record',
  ssoLogoutUrl: 'record',
  ssoEnforced: 'record',
  ssoCertificate: 'redact',
  updatedAt: 'ignore',
  createdAt: 'ignore',
};

/** Webhook: the receiver URL may carry a token in its path (chat-style hooks), so it is fingerprinted. */
export const WEBHOOK_DIFF_SPEC: DiffSpec = {
  url: 'redact',
  events: 'record',
  active: 'record',
  secret: 'redact',
  createdAt: 'ignore',
  updatedAt: 'ignore',
};

/** API key: what it may do and until when; never the hash. */
export const API_KEY_DIFF_SPEC: DiffSpec = {
  name: 'record',
  scopes: 'record',
  expiresAt: 'record',
  quotaPeriod: 'record',
  quotaLimit: 'record',
  revokedAt: 'record',
  hashedKey: 'redact',
  lastUsedAt: 'ignore',
  createdAt: 'ignore',
};
