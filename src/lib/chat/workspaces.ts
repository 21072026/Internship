import type { ChatPlatform } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { isChatAppsEnabled, isChatPlatformConfigured } from '@/lib/chat/config';
import { openBotToken, sealBotToken, sealRefreshToken } from '@/lib/chat/tokens';
import { chatClientFor } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';

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
