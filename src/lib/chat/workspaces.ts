import type { ChatPlatform } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { isChatAppsEnabled, isChatPlatformConfigured } from '@/lib/chat/config';
import { openBotToken, sealBotToken, sealRefreshToken } from '@/lib/chat/tokens';
import { chatClientFor } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';
import { retryChatDelivery } from '@/lib/notifications/router';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';

// The governance of an installed chat app (#1958): see it, switch it off,
// remove it so nothing is left. The ONE writer of ChatWorkspace rows; every
// change writes an AuditLog row with the org on it (a row without one reaches
// no audit drain, docs/audit-stream.md).
//
// Every query is filtered by the caller's own orgId explicitly — another
// tenant's workspace id reads as absent (404), never as forbidden.

export const CHAT_AUDIT = {
  install: 'CHAT_INSTALL',
  enable: 'CHAT_ENABLE',
  disable: 'CHAT_DISABLE',
  uninstall: 'CHAT_UNINSTALL',
} as const;

const PLATFORMS: readonly ChatPlatform[] = ['SLACK', 'TEAMS'];

export interface ChatWorkspaceView {
  id: string;
  platform: ChatPlatform;
  name: string;
  externalId: string;
  installedBy: { id: string; name: string | null; email: string } | null;
  scopes: string[];
  enabled: boolean;
  verifiedIdentities: number;
  lastError: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

export interface ChatStatusView {
  /** CHAT_APPS_ENABLED — nothing is delivered anywhere while false. */
  deliveryEnabled: boolean;
  platforms: { platform: ChatPlatform; configured: boolean }[];
  workspaces: ChatWorkspaceView[];
}

/** The console's view. Never a token: the select names every column it reads. */
export async function chatStatusFor(orgId: string): Promise<ChatStatusView> {
  const rows = await prisma.chatWorkspace.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      platform: true,
      name: true,
      externalId: true,
      installedById: true,
      scope: true,
      enabled: true,
      lastError: true,
      lastDeliveryAt: true,
      createdAt: true,
      _count: { select: { identities: { where: { verifiedAt: { not: null } } } } },
    },
  });
  const installers = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.installedById))] }, orgId },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const byId = new Map(installers.map((u) => [u.id, { id: u.id, name: u.fullName, email: u.email }]));
  return {
    deliveryEnabled: isChatAppsEnabled(),
    platforms: PLATFORMS.map((platform) => ({ platform, configured: isChatPlatformConfigured(platform) })),
    workspaces: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      name: r.name,
      externalId: r.externalId,
      installedBy: byId.get(r.installedById) ?? null,
      scopes: r.scope.split(/[,\s]+/).filter(Boolean),
      enabled: r.enabled,
      verifiedIdentities: r._count.identities,
      lastError: r.lastError,
      lastDeliveryAt: r.lastDeliveryAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export class ChatInstallConflict extends Error {}

/**
 * Record an installation — the OAuth callback's write (#1935). A workspace is
 * one org's: re-installing the same Slack team into ANOTHER org is refused
 * rather than silently moving its bot token across tenants.
 */
export async function recordChatInstall(input: {
  orgId: string;
  platform: ChatPlatform;
  externalId: string;
  name: string;
  botToken: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scope: string;
  installedById: string;
}): Promise<{ id: string }> {
  const existing = await prisma.chatWorkspace.findUnique({
    where: { platform_externalId: { platform: input.platform, externalId: input.externalId } },
    select: { id: true, orgId: true },
  });
  if (existing && existing.orgId !== input.orgId) throw new ChatInstallConflict('workspace_in_other_org');
  const data = {
    name: input.name.slice(0, 191),
    botTokenEnc: input.botToken ? sealBotToken(input.botToken) : null,
    refreshTokenEnc: input.refreshToken ? sealRefreshToken(input.refreshToken) : null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    scope: input.scope,
    installedById: input.installedById,
    lastError: null,
  };
  const row = existing
    ? await prisma.chatWorkspace.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.chatWorkspace.create({
        data: { ...data, orgId: input.orgId, platform: input.platform, externalId: input.externalId.slice(0, 128) },
        select: { id: true },
      });
  await prisma.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: input.installedById,
      action: CHAT_AUDIT.install,
      detail: JSON.stringify({ workspaceId: row.id, platform: input.platform, name: data.name, scope: input.scope, reinstall: Boolean(existing) }),
    },
  });
  return row;
}

/** The kill switch. False when the workspace is not this org's. */
export async function setChatWorkspaceEnabled(orgId: string, id: string, enabled: boolean, actorId: string): Promise<boolean> {
  const ws = await prisma.chatWorkspace.findFirst({ where: { id, orgId }, select: { id: true, platform: true, name: true, enabled: true } });
  if (!ws) return false;
  if (ws.enabled !== enabled) {
    await prisma.chatWorkspace.updateMany({ where: { id, orgId }, data: { enabled } });
  }
  await prisma.auditLog.create({
    data: {
      orgId,
      actorId,
      action: enabled ? CHAT_AUDIT.enable : CHAT_AUDIT.disable,
      detail: JSON.stringify({ workspaceId: id, platform: ws.platform, name: ws.name, changed: ws.enabled !== enabled }),
    },
  });
  return true;
}

export type RevokeOutcome = 'revoked' | 'not_revoked' | 'no_token' | 'no_platform_revoke' | `failed:${string}`;

/**
 * The real uninstall: revoke on the platform's side FIRST, then delete the
 * workspace — its sealed tokens with it, its identities by cascade. Delivery
 * rows survive with `workspaceId` nulled (metadata only, retention-pruned).
 *
 * A failed revoke does not keep the row alive: the admin asked for removal and
 * our copy of the token is the one thing we fully control. The outcome is
 * written to the audit row either way, so "revoke failed" is on the record.
 */
export async function uninstallChatWorkspace(
  orgId: string,
  id: string,
  actorId: string,
): Promise<{ revoke: RevokeOutcome; identitiesRemoved: number } | null> {
  const ws = await prisma.chatWorkspace.findFirst({
    where: { id, orgId },
    select: { id: true, platform: true, name: true, externalId: true, botTokenEnc: true },
  });
  if (!ws) return null;

  let revoke: RevokeOutcome;
  const token = openBotToken(ws.botTokenEnc);
  if (ws.platform === 'SLACK' && !token) {
    revoke = 'no_token';
  } else {
    try {
      const r = await chatClientFor(ws.platform).revoke({ token: token ?? '' });
      revoke = r.revoked ? 'revoked' : r.note === 'teams_has_no_workspace_token' ? 'no_platform_revoke' : 'not_revoked';
    } catch (e) {
      revoke = `failed:${e instanceof ChatClientError ? e.code : 'internal_error'}`;
      logger.warning('chat uninstall: platform revoke failed', { workspaceId: ws.id, platform: ws.platform, code: revoke });
    }
  }

  const identitiesRemoved = await prisma.$transaction(async (tx) => {
    const n = await tx.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await tx.chatWorkspace.deleteMany({ where: { id: ws.id, orgId } });
    await tx.auditLog.create({
      data: {
        orgId,
        actorId,
        action: CHAT_AUDIT.uninstall,
        detail: JSON.stringify({ workspaceId: ws.id, platform: ws.platform, name: ws.name, externalId: ws.externalId, revoke, identitiesRemoved: n.count }),
      },
    });
    return n.count;
  });
  return { revoke, identitiesRemoved };
}

// ── The delivery ledger (#1960) ────────────────────────────────────────────

export const CHAT_LEDGER_MAX = 50;

export interface ChatDeliveryView {
  id: string;
  eventKey: string;
  /** The person it was for, by name — never the chat member id or the card. */
  recipient: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error: string | null;
  createdAt: string;
}

/**
 * The newest attempts of one workspace of this org: event key, recipient name,
 * outcome, reason. Never the card body (it can carry candidate data) and never
 * a token. Null when the workspace is not this org's.
 */
export async function listChatDeliveries(orgId: string, workspaceId: string, limit = CHAT_LEDGER_MAX): Promise<ChatDeliveryView[] | null> {
  const ws = await prisma.chatWorkspace.findFirst({ where: { id: workspaceId, orgId }, select: { id: true } });
  if (!ws) return null;
  const rows = await prisma.chatDelivery.findMany({
    where: { workspaceId, orgId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(CHAT_LEDGER_MAX, Math.floor(limit) || CHAT_LEDGER_MAX)),
    select: { id: true, eventKey: true, status: true, error: true, createdAt: true, identityId: true },
  });
  const identityIds = [...new Set(rows.map((r) => r.identityId).filter((x): x is string => Boolean(x)))];
  const identities = identityIds.length
    ? await prisma.chatIdentity.findMany({
        where: { id: { in: identityIds }, workspaceId },
        select: { id: true, user: { select: { fullName: true, email: true } } },
      })
    : [];
  const nameOf = new Map(identities.map((i) => [i.id, i.user.fullName || i.user.email]));
  return rows.map((r) => ({
    id: r.id,
    eventKey: r.eventKey,
    recipient: r.identityId ? nameOf.get(r.identityId) ?? null : null,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type ChatRetryResult =
  | { ok: true; status: 'SENT' | 'SKIPPED' | 'FAILED'; error?: string }
  | { ok: false; code: 'not_found' | 'not_failed' | 'identity_gone' | 'source_gone' | 'already_retried' };

/**
 * Retry ONE failed delivery — through the router (retryChatDelivery), which
 * writes a NEW ledger row; the failed row is never changed. The card is rebuilt
 * from the person's in-app notification of the same event, created around the
 * failed attempt (the router writes both in one pass).
 */
export async function retryChatDeliveryFor(orgId: string, deliveryId: string, actorId: string): Promise<ChatRetryResult> {
  const d = await prisma.chatDelivery.findFirst({
    where: { id: deliveryId, orgId, workspaceId: { not: null } },
    select: { id: true, status: true, eventKey: true, identityId: true, createdAt: true, workspaceId: true },
  });
  if (!d) return { ok: false, code: 'not_found' };
  if (d.status !== 'FAILED') return { ok: false, code: 'not_failed' };
  const identity = d.identityId
    ? await prisma.chatIdentity.findFirst({
        where: { id: d.identityId, workspaceId: d.workspaceId! },
        select: { userId: true, user: { select: { preferredLanguage: true, orgId: true } } },
      })
    : null;
  if (!identity) return { ok: false, code: 'identity_gone' };
  const source = await prisma.notification.findFirst({
    where: {
      userId: identity.userId,
      type: d.eventKey,
      createdAt: { gte: new Date(d.createdAt.getTime() - 5 * 60_000), lte: new Date(d.createdAt.getTime() + 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    select: { params: true, link: true },
  });
  if (!source) return { ok: false, code: 'source_gone' };

  const lang = identity.user.preferredLanguage;
  const out = await retryChatDelivery({
    failedDeliveryId: d.id,
    userId: identity.userId,
    orgId: identity.user.orgId ?? orgId,
    eventKey: d.eventKey,
    params: (source.params && typeof source.params === 'object' && !Array.isArray(source.params) ? source.params : {}) as Record<string, string | number>,
    link: source.link ?? '/',
    locale: isLocale(lang ?? undefined) ? (lang as Locale) : defaultLocale,
  });
  if (out.status === 'DUPLICATE') return { ok: false, code: 'already_retried' };
  logger.info('chat delivery retried', { deliveryId: d.id, actorId, status: out.status });
  return { ok: true, status: out.status, error: out.error };
}
