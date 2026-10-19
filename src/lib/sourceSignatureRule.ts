import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// HMAC request signing for a registered integration source (#2978) — the rule
// half, free of Prisma and of every other module of ours, so
// scripts/test/source-signature.test.mjs pins it with fixed vectors. The guard
// that applies it (raw body, sealed secrets, the answers) is
// src/lib/integrationSourceGuard.ts; the recipe a sender programs against is
// docs/integrations/account-events.md § Security, test vector included.
//
// THE RECIPE (house style of the audit stream's `signBatch`,
// src/lib/auditDrainRule.ts — `sha256=<hex>` over exact bytes — plus a
// timestamp, because here WE are the receiver and a captured request must
// stop working):
//
//   X-Timestamp: <unix seconds>
//   X-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>" + "." + <raw body bytes>)>
//
// THE ORDER of the verdict: the signature first, the clock second. A request
// whose signature does not verify against any live secret is `bad_signature`
// whatever its timestamp; only a sender that holds the secret learns that its
// clock is off (`stale_signature`). A replay inside the window is harmless by
// design — every event is claimed once by its `event_id`, so the same body
// twice answers `duplicate` — which is why the window may be minutes, not
// seconds.
//
// ROTATION: a new secret replaces the current one and the old one stays valid
// for SIGNING_SECRET_OVERLAP_MS, so a sender that is still running with it is
// not cut off between the operator's click and its redeploy.

/** |now − X-Timestamp| above this is `stale_signature`. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;
/** How long a rotated-out secret still verifies. */
export const SIGNING_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';
/** The secretBox purpose the stored secrets are sealed under (src/lib/secretBox.ts). */
export const SIGNING_SECRET_PURPOSE = 'integration-source-signing';
const SECRET_PREFIX = 'isig_';

export type SignatureRefusal = 'bad_signature' | 'stale_signature';

/** A fresh signing secret: `isig_` + 64 hex characters. The HMAC key is the whole string, as UTF-8. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
}

function bodyBytes(rawBody: Uint8Array | string): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
}

/** The signed bytes: `<timestamp>.<raw body>`. */
export function signedPayload(timestamp: string, rawBody: Uint8Array | string): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), bodyBytes(rawBody)]);
}

/** The `X-Signature` value for this secret, timestamp and body. */
export function computeSignature(secret: string, timestamp: string, rawBody: Uint8Array | string): string {
  return `sha256=${createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex')}`;
}

/** The 32 digest bytes of a well-formed `sha256=<64 hex>` header, else null. */
function presentedDigest(header: string | null | undefined): Buffer | null {
  if (typeof header !== 'string') return null;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  return m ? Buffer.from(m[1], 'hex') : null;
}

export interface VerifyInput {
  /** The plaintext secrets that verify right now (current first); empty = nothing can verify. */
  secrets: readonly string[];
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: Uint8Array | string;
  nowMs: number;
}

export type VerifyResult = { ok: true; secretIndex: number } | { ok: false; code: SignatureRefusal };

export function verifySourceSignature(input: VerifyInput): VerifyResult {
  const digest = presentedDigest(input.signature);
  const ts = typeof input.timestamp === 'string' ? input.timestamp.trim() : '';
  // Whole seconds only: a timestamp the server would read differently from the
  // sender (a fraction, an exponent, a sign) has no single signed meaning.
  if (!digest || !/^\d{1,12}$/.test(ts)) return { ok: false, code: 'bad_signature' };
  let match = -1;
  // Every secret is tried, so the time taken does not say which one matched.
  input.secrets.forEach((secret, index) => {
    const expected = createHmac('sha256', secret).update(signedPayload(ts, input.rawBody)).digest();
    if (timingSafeEqual(expected, digest) && match < 0) match = index;
  });
  if (match < 0) return { ok: false, code: 'bad_signature' };
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(ts)) > SIGNATURE_MAX_SKEW_SECONDS) {
    return { ok: false, code: 'stale_signature' };
  }
  return { ok: true, secretIndex: match };
}

export interface StoredSigning {
  /** Plaintext (already opened) — null when signing is off or the value cannot be opened. */
  current: string | null;
  previous: string | null;
  previousUntil: Date | null;
}

/** The secrets that verify at `nowMs`: the current one, and the previous one inside its overlap. */
export function liveSecrets(stored: StoredSigning, nowMs: number): string[] {
  const out: string[] = [];
  if (stored.current) out.push(stored.current);
  if (stored.previous && stored.previousUntil && stored.previousUntil.getTime() > nowMs) out.push(stored.previous);
  return out;
}

/** The overlap end for a rotation at `nowMs`. */
export function overlapUntil(nowMs: number): Date {
  return new Date(nowMs + SIGNING_SECRET_OVERLAP_MS);
}
