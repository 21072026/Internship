// The scope vocabulary for programmatic API keys (#1545).
//
// CLIENT-SAFE on purpose: the admin integrations screen renders the checkbox
// list from here, so this module must never import prisma or anything
// server-only. The server-side helpers that touch the DB live in lib/apiKey.ts.
//
// Naming shape: `<resource>:<action>`, lowercase, singular action verbs
// (`read`, later `write`). Exactly ONE scope exists today because exactly one
// /api/v1 route exists (`GET /api/v1/candidates`) — the point of fixing the
// shape now is that adding `companies:read` or `candidates:write` later is a
// list entry, not a format migration. A key carrying an unknown scope string is
// treated as holding nothing.
//
// NOTE: nothing here enforces anything. Checking a scope at the door of an
// /api/v1 route is #1546; this module defines and parses the vocabulary.

export const API_SCOPES = ['candidates:read'] as const;

export type ApiScope = (typeof API_SCOPES)[number];

// What a key gets when nothing else is said (and what the backfill writes onto
// rows minted before scopes existed): exactly the surface those keys could
// already read.
export const DEFAULT_API_SCOPES: readonly ApiScope[] = ['candidates:read'];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

// Storage format is one comma-separated string (see ApiKey.scopes) — a String
// column keeps the model portable and keeps `db push` additive. Parsing
// tolerates stray whitespace, duplicates and empty segments.
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

export function serializeScopes(scopes: readonly string[]): string {
  return Array.from(new Set(scopes.map((s) => s.trim()).filter(Boolean))).join(',');
}

// ── Expiry ───────────────────────────────────────────────────────────────────
// A key may be minted without an expiry (the admin UI warns about it), but an
// expiry that IS given can never be further out than a year: a credential
// nobody remembers is the one that leaks.
export const MAX_API_KEY_EXPIRY_MONTHS = 12;

export function maxApiKeyExpiry(from: Date = new Date()): Date {
  const max = new Date(from);
  max.setMonth(max.getMonth() + MAX_API_KEY_EXPIRY_MONTHS);
  return max;
}

// ── Derived status ───────────────────────────────────────────────────────────
// Revocation wins over expiry: a key that was withdrawn stays "revoked" even
// after its expiry date passes, because that is the fact an auditor cares about.
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export function apiKeyStatus(
  key: { expiresAt?: Date | string | null; revokedAt?: Date | string | null },
  now: Date = new Date(),
): ApiKeyStatus {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}
