// The account-event door's per-source hardening (#2978): the IP allowlist and
// the HMAC request signature of ONE resolved integration source, applied by
// both routes (`/api/integrations/[source]/events` and its `/batch`, dry run
// included) right after the source and its key binding are known and before
// the body is parsed. The rules are pure in src/lib/sourceIpAllowlistRule.ts
// and src/lib/sourceSignatureRule.ts; the contract is
// docs/integrations/account-events.md § Security.
//
// WHY HERE IN THE ORDER. Both checks run AFTER the API key: a caller without a
// working key gets the door's one 401 and learns nothing about a source, its
// list or whether it signs. They run BEFORE the capability gate and the
// envelope, so a request from a wrong address or without a valid signature is
// never read as an event.
//
// WHAT IS LOGGED. A refusal logs the org, the source's slug, the client address
// and the code — never the body, a header value or a secret.
//
// SERVER-ONLY: secretBox derives keys from NEXTAUTH_SECRET.
import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/clientIp';
import { logger } from '@/lib/logger';
import { open } from '@/lib/secretBox';
import { ipInAllowlist, storedAllowlist } from '@/lib/sourceIpAllowlistRule';
import {
  liveSecrets,
  SIGNATURE_HEADER,
  SIGNING_SECRET_PURPOSE,
  TIMESTAMP_HEADER,
  verifySourceSignature,
} from '@/lib/sourceSignatureRule';
import type { ResolvedIntegrationSource } from '@/lib/integrationSources';

export type GuardOutcome = { ok: true; rawBody: Buffer } | { ok: false; response: NextResponse };

const REFUSALS = {
  source_ip_not_allowed: { status: 403, error: 'This integration source does not accept requests from your address.' },
  bad_signature: { status: 401, error: 'The request signature is missing or does not verify.' },
  stale_signature: { status: 401, error: 'The request timestamp is too far from the server clock. Sign with the current time.' },
} as const;

function refuse(code: keyof typeof REFUSALS, orgId: string, source: ResolvedIntegrationSource, ip: string): GuardOutcome {
  logger.warning('integration source request refused', { code, orgId, source: source.slug, ip });
  const { status, error } = REFUSALS[code];
  return { ok: false, response: NextResponse.json({ code, error }, { status }) };
}

/**
 * The allowlist, then the body read as raw bytes and its signature. On success
 * the caller parses `rawBody` itself — the bytes that were verified are the
 * bytes that are read.
 */
export async function guardSourceRequest(
  request: Request,
  orgId: string,
  source: ResolvedIntegrationSource,
): Promise<GuardOutcome> {
  const ip = clientIp(request);

  const allowlist = storedAllowlist(source.guard.allowedIps);
  if (allowlist !== null && !ipInAllowlist(ip, allowlist)) return refuse('source_ip_not_allowed', orgId, source, ip);

  const rawBody = Buffer.from(await request.arrayBuffer());

  if (source.guard.signingSecret) {
    const current = open(source.guard.signingSecret, SIGNING_SECRET_PURPOSE);
    const previous = source.guard.signingSecretPrevious ? open(source.guard.signingSecretPrevious, SIGNING_SECRET_PURPOSE) : null;
    if (!current) {
      // A sealed secret that cannot be opened (the server secret changed, the
      // row was copied from another environment) verifies nothing: the source
      // stays shut until an admin generates a new secret.
      logger.error('integration source signing secret cannot be opened', { orgId, source: source.slug });
    }
    const verdict = verifySourceSignature({
      secrets: liveSecrets({ current, previous, previousUntil: source.guard.signingPreviousUntil }, Date.now()),
      timestamp: request.headers.get(TIMESTAMP_HEADER),
      signature: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      nowMs: Date.now(),
    });
    if (!verdict.ok) return refuse(verdict.code, orgId, source, ip);
  }

  return { ok: true, rawBody };
}

/**
 * The verified bytes as JSON, or null — the routes' former
 * `request.json().catch(() => null)`, byte for byte: TextDecoder drops a
 * leading BOM exactly as `Request.json()` does.
 */
export function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
}
