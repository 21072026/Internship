// Host → WORLD (docs/worlds.md, epic #2348).
//
// A "world" is one PRODUCT a person can be inside: today the internship CRM
// (INTERNSHIP) and the marketing CRM (MARKETING). It is the vertical of an
// organization — `Organization.vertical` — and nothing new is stored for it.
// What this module adds is the rule the maintainer stated in one sentence:
//
//   The URL you signed in on decides which application you are using.
//
// So one person (one e-mail) can hold an account in each world, and
// marketing.bcsit-gmbh.de shows them the marketing product while interncrm.com
// shows the internship one — the same way they are already two separate
// tenants with two separate data sets.
//
// PURE ON PURPOSE (imports only the two zero-dependency catalogue/host modules,
// relatively, so `node --test --experimental-strip-types` can load it). The
// Prisma half — "which user row is this person's account in this world" — is
// src/lib/userWorld.ts.
//
// TRUST NOTE. The host signal is the proxy's X-Forwarded-Host (Caddy overwrites
// it) — the same signal hostVertical.ts reads, with the same contract: it may
// choose WHICH of a person's own accounts they are signed into, and it may
// REFUSE a request; it must never widen what anyone can reach. A forged header
// can only make the forger's own sign-in fail or pick their own other account.

import { configuredOrigin, hostnameOf, marketingHosts } from './servedHosts';
import { DEFAULT_VERTICAL, type VerticalKey } from './verticals';

export type World = VerticalKey;

type HeaderGetter = (name: string) => string | null | undefined;

/** The world a Host / X-Forwarded-Host header value belongs to. Total: an unknown host is the default world. */
export function worldForHostHeader(hostHeader: string | null | undefined): World {
  const host = hostnameOf(hostHeader);
  if (host && marketingHosts().has(host)) return 'MARKETING';
  return DEFAULT_VERTICAL;
}

/** The world of a request, from any header accessor. X-Forwarded-Host first, then Host. */
export function worldForHeaders(get: HeaderGetter): World {
  return worldForHostHeader(get('x-forwarded-host') ?? get('host'));
}

type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null } | null | undefined;

/**
 * The world of a request whose headers arrive as NextAuth hands them to
 * `authorize()` — a plain (lower-cased) object, not a WHATWG Headers — or as a
 * real Headers. Anything unreadable is the default world.
 */
export function worldForHeaderBag(bag: HeaderBag): World {
  if (!bag) return DEFAULT_VERTICAL;
  if (typeof (bag as { get?: unknown }).get === 'function') {
    const h = bag as { get(name: string): string | null };
    return worldForHeaders((n) => h.get(n));
  }
  const rec = bag as Record<string, string | string[] | undefined>;
  const pick = (name: string): string | null => {
    const v = rec[name] ?? rec[name.toLowerCase()];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };
  return worldForHeaders(pick);
}

/** The first configured marketing host — the one links into the marketing product point at. */
export function primaryMarketingHost(): string {
  return [...marketingHosts()][0];
}

/**
 * The public origin of a world: what a LINK IN AN E-MAIL must start with so it
 * opens the product the recipient's account lives in.
 *
 * INTERNSHIP is the origin every e-mail builder already used
 * (NEXT_PUBLIC_APP_URL, else the configured origin), so choosing it is a no-op.
 * MARKETING is the first MARKETING_HOSTS entry on the deployment's own scheme;
 * a port is re-attached only when the marketing host IS the configured host
 * (a developer's `localhost`), never for a real domain.
 */
export function originForWorld(world: World): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const internship = (appUrl && appUrl.trim() ? appUrl : configuredOrigin()).replace(/\/+$/, '');
  if (world !== 'MARKETING') return internship;
  let base: URL;
  try {
    base = new URL(configuredOrigin());
  } catch {
    return internship;
  }
  const host = primaryMarketingHost();
  const port = base.hostname === host && base.port ? `:${base.port}` : '';
  return `${base.protocol}//${host}${port}`;
}

/** Every world with the origin its links use — for a sign-in page that must point at "the other door". */
export function worldOrigins(): Record<World, string> {
  return { INTERNSHIP: originForWorld('INTERNSHIP'), MARKETING: originForWorld('MARKETING') };
}
