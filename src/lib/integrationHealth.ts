import { X509Certificate } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getEmailHealth } from '@/lib/emailHealth';
import { isGoogleCalendarConfigured, isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { isSsoConfigComplete } from '@/lib/sso';
import { sanitizeError } from '@/lib/sanitizeError';

// Per-connector integration health (#2008). Every row is DERIVED from the
// ledger that connector already writes — EmailLog, GoogleCalendarConnection's
// lastSyncAt/lastError, the Webhook table, Organization's sso* fields, the two
// receivers' own env gates. No connector gets a new "last state" column: the
// same reasoning as emailHealth.ts, a separate marker is written by one code
// path and read by another, and the two drift the first time a write is missed.
//
// Server-only (imports prisma). Two kinds of row (#1555): the rows read from
// what a TENANT owns — its webhooks, its audit drains, its own SSO
// configuration, its members' calendar connections — are scoped to the asking
// admin's org, because a tenant admin must not learn how many endpoints another
// tenant registered, when it last added one, or when its IdP certificate
// expires. The rows read from the deployment itself (the SMTP ledger, the two
// receivers' env gates) stay deployment-wide: there is one of each.
//
// The array shape and the `state` vocabulary are a stable contract:
// /admin/operations (#1607) counts states from GET
// /api/admin/integrations/health for its roll-up, so `state` must stay
// machine-countable and never turn into prose.

export type ConnectorState = 'ok' | 'degraded' | 'failing' | 'not_configured';

export type ConnectorId =
  | 'email'
  | 'webhooks'
  | 'google_calendar'
  | 'sso'
  | 'inbound_jaas'
  | 'inbound_email'
  | 'audit_drain';

export interface ConnectorHealth {
  connector: ConnectorId;
  state: ConnectorState;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  // Always through sanitizeError — a connector error can hold an address, a
  // token or a certificate body.
  lastError: string | null;
  // Connector-specific counters for the UI. Never an identity (no recipient, no
  // accountEmail, no issuer) and never a secret or its length.
  detail: Record<string, string | number | boolean | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// An IdP certificate that lapses takes every SSO login with it, and rotating one
// needs the tenant's IdP admin — a month is the shortest notice that is useful.
const CERT_WARN_DAYS = 30;

async function emailRow(): Promise<ConnectorHealth> {
  const health = await getEmailHealth();
  const state: ConnectorState =
    !health.lastOkAt && health.attempts24h === 0 && health.failuresSinceOk === 0
      ? 'not_configured'
      : health.failuresSinceOk >= 3
        ? 'failing'
        : health.failuresSinceOk > 0
          ? 'degraded'
          : 'ok';
  return {
    connector: 'email',
    state,
    lastOkAt: health.lastOkAt,
    lastErrorAt: health.lastErrorAt,
    // Already sanitized by getEmailHealth().
    lastError: health.lastError,
    detail: { failuresSinceOk: health.failuresSinceOk, attempts24h: health.attempts24h },
  };
}

// A null org (a legacy session) matches only the legacy null-org rows, the
// same rule the webhook dispatch and the admin webhook list apply — never
// "every tenant's".
async function webhooksRow(orgId: string | null): Promise<ConnectorHealth> {
  const [total, active, latest] = await Promise.all([
    prisma.webhook.count({ where: { orgId } }),
    prisma.webhook.count({ where: { orgId, active: true } }),
    prisma.webhook.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  // Subscription state only. There is no WebhookDelivery ledger yet (#1681 /
  // #1695 bring it), and inventing a second delivery record here would be
  // exactly the drifting marker the module avoids elsewhere — so the row says
  // so instead of guessing.
  return {
    connector: 'webhooks',
    state: total === 0 ? 'not_configured' : active === 0 ? 'degraded' : 'ok',
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    detail: {
      total,
      active,
      lastCreatedAt: latest?.createdAt.toISOString() ?? null,
      deliveryHealthPending: true,
    },
  };
}

async function googleCalendarRow(orgId: string | null): Promise<ConnectorHealth> {
  const configured = isGoogleCalendarConfigured();
  // A connection belongs to a person; the person to a tenant.
  const mine = { provider: 'GOOGLE' as const, user: { orgId } };
  const [connections, broken, lastSync, lastFail] = await Promise.all([
    prisma.calendarConnection.count({ where: mine }),
    prisma.calendarConnection.count({ where: { ...mine, lastError: { not: null } } }),
    prisma.calendarConnection.findFirst({
      where: { ...mine, lastSyncAt: { not: null } },
      orderBy: { lastSyncAt: 'desc' },
      select: { lastSyncAt: true },
    }),
    prisma.calendarConnection.findFirst({
      where: { ...mine, lastError: { not: null } },
      orderBy: { updatedAt: 'desc' },
      // Never accountEmail — the operator figure is "how many are broken", not
      // whose account it is.
      select: { updatedAt: true, lastError: true },
    }),
  ]);
  const state: ConnectorState = !configured
    ? 'not_configured'
    : broken > 0 && broken === connections
      ? 'failing'
      : broken > 0
        ? 'degraded'
        : 'ok';
  return {
    connector: 'google_calendar',
    state,
    lastOkAt: lastSync?.lastSyncAt?.toISOString() ?? null,
    lastErrorAt: lastFail?.updatedAt.toISOString() ?? null,
    lastError: sanitizeError(lastFail?.lastError),
    detail: { configured, enabled: isGoogleCalendarEnabled(), connections, broken },
  };
}

// Expiry of a SAML signing certificate. The stored value may or may not carry
// PEM armour, and an IdP export is occasionally malformed — either way the PEM
// itself must never reach the response, so the caller only gets a date or null.
function certValidTo(pem: string): Date | null {
  const armoured = pem.includes('BEGIN')
    ? pem
    : `-----BEGIN CERTIFICATE-----\n${pem.trim()}\n-----END CERTIFICATE-----`;
  try {
    const validTo = new Date(new X509Certificate(armoured).validTo);
    return Number.isNaN(validTo.getTime()) ? null : validTo;
  } catch {
    return null;
  }
}

async function ssoRow(orgId: string | null): Promise<ConnectorHealth> {
  // The asking tenant's own configuration only. No org → nothing to report.
  const orgs = orgId ? await prisma.organization.findMany({
    where: { id: orgId, ssoEnabled: true },
    select: {
      ssoProvider: true,
      ssoIssuer: true,
      ssoEntryPoint: true,
      ssoCertificate: true,
    },
  }) : [];
  if (orgs.length === 0) {
    return {
      connector: 'sso',
      state: 'not_configured',
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      detail: { enabledOrgs: 0, incomplete: 0, certExpiresAt: null, certDaysLeft: null },
    };
  }

  const incomplete = orgs.filter((o) => !isSsoConfigComplete({ ...o, ssoEnabled: true })).length;
  // Soonest expiry: the board reports the deadline that arrives first, and no
  // issuer goes into the payload.
  let soonest: Date | null = null;
  let unparseable = 0;
  for (const org of orgs) {
    if (org.ssoProvider !== 'saml' || !org.ssoCertificate) continue;
    const validTo = certValidTo(org.ssoCertificate);
    if (!validTo) {
      unparseable += 1;
      continue;
    }
    if (!soonest || validTo < soonest) soonest = validTo;
  }
  const daysLeft = soonest ? Math.floor((soonest.getTime() - Date.now()) / DAY_MS) : null;

  let state: ConnectorState = 'ok';
  let lastError: string | null = null;
  if (incomplete > 0) {
    state = 'failing';
    lastError = 'SSO enabled with an incomplete configuration';
  } else if (daysLeft !== null && daysLeft < 0) {
    state = 'failing';
    lastError = 'IdP certificate has expired';
  } else if (unparseable > 0) {
    state = 'degraded';
    lastError = 'IdP certificate could not be parsed';
  } else if (daysLeft !== null && daysLeft <= CERT_WARN_DAYS) {
    state = 'degraded';
    lastError = `IdP certificate expires in ${daysLeft} day(s)`;
  }

  return {
    connector: 'sso',
    state,
    lastOkAt: null,
    lastErrorAt: null,
    lastError,
    detail: {
      enabledOrgs: orgs.length,
      incomplete,
      certExpiresAt: soonest?.toISOString() ?? null,
      certDaysLeft: daysLeft,
    },
  };
}

// The two inbound receivers have no ledger of their own — their health IS their
// env gate, read exactly as the routes read it. Absent means `not_configured`
// and never `failing`: both endpoints answer 404/401 by design when unset, so a
// deployment that does not use them is healthy, not broken.
function inboundRow(connector: 'inbound_jaas' | 'inbound_email', secret: string | undefined): ConnectorHealth {
  const configured = Boolean(secret?.trim());
  return {
    connector,
    state: configured ? 'ok' : 'not_configured',
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    // The boolean only. Not the value, not its length.
    detail: { configured },
  };
}

// The audit stream (#2012). Unlike webhooks this one HAS a delivery ledger —
// the drain row itself carries lastOkAt / lastError / failures, written by the
// same code path that delivers — so the row is derived from it, for the asking
// tenant's drains only. A drain that paused itself after the failure ceiling
// (`active: false` with failures > 0) is the loudest state: nothing is being
// shipped and nothing will be until a human resumes it. A deployment with no
// drain at all is `not_configured`, not broken.
async function auditDrainRow(orgId: string | null): Promise<ConnectorHealth> {
  // AuditDrain.orgId is required, so a null org matches nothing: not configured.
  const mine = { orgId: orgId ?? '' };
  const [total, active, failing, pausedAuto, lastOk, lastFail] = await Promise.all([
    prisma.auditDrain.count({ where: mine }),
    prisma.auditDrain.count({ where: { ...mine, active: true } }),
    prisma.auditDrain.count({ where: { ...mine, active: true, failures: { gt: 0 } } }),
    prisma.auditDrain.count({ where: { ...mine, active: false, failures: { gt: 0 } } }),
    prisma.auditDrain.findFirst({ where: { ...mine, lastOkAt: { not: null } }, orderBy: { lastOkAt: 'desc' }, select: { lastOkAt: true } }),
    prisma.auditDrain.findFirst({
      where: { ...mine, lastError: { not: null } },
      orderBy: { updatedAt: 'desc' },
      // Never the URL — the operator figure is "is it delivering", not where to.
      select: { updatedAt: true, lastError: true },
    }),
  ]);
  const state: ConnectorState = total === 0
    ? 'not_configured'
    : pausedAuto > 0 || (active > 0 && failing === active)
      ? 'failing'
      : failing > 0 || active === 0
        ? 'degraded'
        : 'ok';
  return {
    connector: 'audit_drain',
    state,
    lastOkAt: lastOk?.lastOkAt?.toISOString() ?? null,
    lastErrorAt: lastFail?.updatedAt.toISOString() ?? null,
    lastError: sanitizeError(lastFail?.lastError),
    detail: { total, active, failing, pausedAuto },
  };
}

export async function getIntegrationHealth(orgId: string | null): Promise<ConnectorHealth[]> {
  const [email, webhooks, google, sso, auditDrain] = await Promise.all([
    emailRow(),
    webhooksRow(orgId),
    googleCalendarRow(orgId),
    ssoRow(orgId),
    auditDrainRow(orgId),
  ]);
  return [
    email,
    webhooks,
    google,
    sso,
    inboundRow('inbound_jaas', process.env.JAAS_WEBHOOK_SECRET),
    inboundRow('inbound_email', process.env.INBOUND_SECRET),
    auditDrain,
  ];
}
