// The scope vocabulary for programmatic API keys (#1545).
//
// CLIENT-SAFE on purpose: the admin integrations screen renders the checkbox
// list from here, so this module must never import prisma or anything
// server-only. The server-side helpers that touch the DB live in lib/apiKey.ts.
//
// Naming shape: `<resource>:<action>`, lowercase, singular action verbs
// (`read`, `write`). `candidates:read` is `GET /api/v1/candidates`;
// `companies:write` (#2450) is the first WRITE scope — the machine-to-machine
// account ingest, `POST /api/integrations/<source>/events` (#2914), deliberately
// outside the frozen /api/v1. Never a default: an admin grants it to the one key
// an upstream source system uses. A key carrying an unknown scope string is
// treated as holding nothing.
//
// NOTE: nothing here enforces anything. Checking a scope at the door of an
// /api/v1 route is #1546; this module defines and parses the vocabulary.

export const API_SCOPES = [
  'candidates:read',
  // Read breadth (#1990): one scope per resource family, so a BI tool can be
  // given relationships without being given meetings.
  'relationships:read',
  'interactions:read',
  // The free-text body of an interaction log — the most sensitive text in the
  // product. Never implied by interactions:read; granted on its own, on purpose.
  'interactions:read_notes',
  'meetings:read',
  'companies:read',
  // Requisitions, offers and interview requests: what an ATS reacts to.
  'hiring:read',
  'companies:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

// What a key gets when nothing else is said (and what the backfill writes onto
// rows minted before scopes existed): exactly the surface those keys could
// already read.
export const DEFAULT_API_SCOPES: readonly ApiScope[] = ['candidates:read'];

// Which paid feature a scope belongs to (#1744), or null with the reason it is
// not sold. A Record over every scope, so a new scope cannot be added without
// deciding: the door (withApiKey) and API-key issuing both read this, and
// scripts/check-api-key-routes.mjs fails an /api/v1 route whose scope maps to
// anything but INTEGRATIONS_API.
//   candidates:read  — the public API the plans sell ("public API + webhooks").
//   companies:write  — NOT the public API: the account-event ingest a
//                      tenant's own registered source system posts to (#2450,
//                      docs/integrations/account-events.md). Gating it would
//                      switch off the tenant's own data feed.
export const SCOPE_ENTITLEMENT: Record<ApiScope, 'INTEGRATIONS_API' | null> = {
  'candidates:read': 'INTEGRATIONS_API',
  'relationships:read': 'INTEGRATIONS_API',
  'interactions:read': 'INTEGRATIONS_API',
  'interactions:read_notes': 'INTEGRATIONS_API',
  'meetings:read': 'INTEGRATIONS_API',
  'companies:read': 'INTEGRATIONS_API',
  'hiring:read': 'INTEGRATIONS_API',
  'companies:write': null,
};

/** The scopes among `scopes` that need INTEGRATIONS_API. */
export function publicApiScopes(scopes: readonly string[]): ApiScope[] {
  return scopes.filter((s): s is ApiScope => isApiScope(s) && SCOPE_ENTITLEMENT[s] === 'INTEGRATIONS_API');
}

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
