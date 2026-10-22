// Where a Klaviyo connection's key comes from (docs/integrations/klaviyo.md
// § The key): sealed in the database (pasted by the org's admin), or the
// server's environment (`KLAVIYO_PRIVATE_API_KEY`, bound to ONE organization
// by `KLAVIYO_ORG_ID`). An environment key is NEVER written to the database —
// its connection row carries `env:<sha256 of the key>` instead of a sealed copy
// (KLAVIYO_ENV_KEY_PREFIX), so a rotated environment key is noticed and the
// key itself only ever lives in the process environment.
//
// Server-only: node:crypto and the secret box.
import { createHash } from 'node:crypto';
import { open } from '@/lib/secretBox';
import { KLAVIYO_ENV_KEY_PREFIX, KLAVIYO_SECRET_PURPOSE, checkKlaviyoKey, isEnvKeyRef } from '@/lib/klaviyoRule';

/** The environment's key when it is a well-formed private key, else null. */
export function envKlaviyoKey(): string | null {
  const check = checkKlaviyoKey(process.env.KLAVIYO_PRIVATE_API_KEY);
  return check.ok ? check.key : null;
}

/** The organization (id or slug) the environment key belongs to. */
export function envKlaviyoOrgRef(): string | null {
  return (process.env.KLAVIYO_ORG_ID || '').trim() || null;
}

/** What a connection row stores for an environment key: a fingerprint, never the key. */
export function envKeyRef(key: string): string {
  return `${KLAVIYO_ENV_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * The key a connection row opens to: the sealed one, or — for an environment
 * row — the environment's key while it still matches the fingerprint. A
 * changed or removed environment key opens to null (`key_unreadable`) until
 * the next tick re-binds the row (ensureEnvKlaviyoConnection).
 */
export function openConnectionKey(sealedKey: string): string | null {
  if (isEnvKeyRef(sealedKey)) {
    const key = envKlaviyoKey();
    return key && envKeyRef(key) === sealedKey ? key : null;
  }
  return open(sealedKey, KLAVIYO_SECRET_PURPOSE);
}

export function keySourceOf(sealedKey: string): 'env' | 'db' {
  return isEnvKeyRef(sealedKey) ? 'env' : 'db';
}
