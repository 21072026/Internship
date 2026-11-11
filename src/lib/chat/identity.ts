import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { chatClientFor, type ChatPlatformClient, type ChatTarget } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';
import { freshSlackBotToken } from '@/lib/chat/tokenRefresh';

// "This chat member is this CRM user" (#1937) — the join everything in the chat
// epic stands on. A wrong mapping DMs one mentee's interview approval to
// another person, so the link is a CONFIRMED fact:
//
//   1. PROPOSED from a verified address on BOTH sides — the platform's
//      directory e-mail and an `emailVerified` account of the workspace's own
//      org (pinned by `orgId`, so never another tenant or world). No match, an
//      unverified account or a member without an address creates NOTHING, and
//      a chat directory never provisions a user (ssoProvisioning.ts is the one
//      place a provider-asserted address may create an account).
//   2. CONFIRMED by the person themselves (verifiedAt). Nothing is delivered to
//      an unconfirmed identity — the router asks for verifiedAt.
//   3. REVOCABLE by the person (their own) or an ADMIN of the org. Revoking
//      deletes the row; the router simply stops adding `chat` for them, and
//      their other channels carry on.
//
// The two unique constraints (one member per user per workspace, one user per
// member per workspace) are the database half of "two CRM users can never
// claim the same chat member" — a proposal that would break one is skipped.

export class IdentityError extends Error {
  constructor(public readonly code: 'not_found' | 'forbidden' | 'not_supported' | 'no_token' | 'platform_error') {
    super(code);
  }
}

export interface ProposeResult {
  proposed: number;
  alreadyLinked: number;
  unmatched: number;
}

/**
 * Propose identities for every member of one workspace of this org whose
 * platform-verified address belongs to a verified, active account of the org.
 * Idempotent: an existing link (either side) is left alone.
 */
export async function proposeIdentitiesForWorkspace(orgId: string, workspaceId: string, client?: ChatPlatformClient): Promise<ProposeResult> {
  const ws = await prisma.chatWorkspace.findFirst({
    where: { id: workspaceId, orgId },
    select: { id: true, orgId: true, platform: true, externalId: true, botTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
  });
  if (!ws) throw new IdentityError('not_found');
  const platformClient = client ?? chatClientFor(ws.platform);
  let token = '';
  if (ws.platform === 'SLACK') {
    token = (await freshSlackBotToken(ws)) ?? '';
    if (!token) throw new IdentityError('no_token');
  }
  let members;
  try {
    members = await platformClient.listMembers({ token, externalId: ws.externalId });
  } catch (e) {
    throw new IdentityError(e instanceof ChatClientError && e.code === 'not_supported' ? 'not_supported' : 'platform_error');
  }

  const withEmail = members.filter((m) => m.verifiedEmail);
  const emails = [...new Set(withEmail.map((m) => m.verifiedEmail!))];
  // Pinned by orgId: the workspace's own tenant, so its own world.
  const users = emails.length
    ? await prisma.user.findMany({
        where: { orgId, email: { in: emails }, emailVerified: true, isActive: true },
        select: { id: true, email: true },
      })
    : [];
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  const result: ProposeResult = { proposed: 0, alreadyLinked: 0, unmatched: members.length - withEmail.length };
  for (const m of withEmail) {
    const userId = byEmail.get(m.verifiedEmail!);
    if (!userId) {
      result.unmatched += 1;
      continue;
    }
    try {
      await prisma.chatIdentity.create({
        data: {
          orgId: ws.orgId,
          workspaceId: ws.id,
          userId,
          externalUserId: m.externalUserId.slice(0, 128),
          displayName: m.displayName.slice(0, 191),
        },
      });
      result.proposed += 1;
    } catch (e) {
      // Either unique constraint: this user already has a member here, or this
      // member is already someone's. Never overwritten by a proposal.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') result.alreadyLinked += 1;
      else throw e;
    }
  }
  return result;
}

export interface MyChatIdentity {
  id: string;
  workspaceName: string;
  platform: 'SLACK' | 'TEAMS';
  displayName: string | null;
  confirmed: boolean;
}

/** The signed-in person's own links, for their account page. */
export async function myChatIdentities(userId: string): Promise<MyChatIdentity[]> {
  const rows = await prisma.chatIdentity.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, displayName: true, verifiedAt: true, workspace: { select: { name: true, platform: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    workspaceName: r.workspace.name,
    platform: r.workspace.platform,
    displayName: r.displayName,
    confirmed: r.verifiedAt !== null,
  }));
}

/** The person confirms a proposal: only their own, and only once (a guarded update). */
export async function confirmIdentity(userId: string, identityId: string): Promise<void> {
  const n = await prisma.chatIdentity.updateMany({ where: { id: identityId, userId, verifiedAt: null }, data: { verifiedAt: new Date() } });
  if (n.count === 1) return;
  const own = await prisma.chatIdentity.count({ where: { id: identityId, userId } });
  if (!own) throw new IdentityError('not_found');
}

/**
 * Remove a link. The person may remove their own; an ADMIN any of their org's
 * (`adminOrgId`). Anything else is not_found for a missing row and forbidden
 * for someone else's — the route maps them to 404 / 403.
 */
export async function revokeIdentity(actor: { userId: string; adminOrgId: string | null }, identityId: string): Promise<void> {
  const row = await prisma.chatIdentity.findUnique({ where: { id: identityId }, select: { userId: true, orgId: true } });
  if (!row) throw new IdentityError('not_found');
  const own = row.userId === actor.userId;
  const orgAdmin = actor.adminOrgId !== null && row.orgId === actor.adminOrgId;
  if (!own && !orgAdmin) throw new IdentityError('forbidden');
  await prisma.chatIdentity.deleteMany({ where: { id: identityId } });
}

/**
 * Where the adapter sends to: the cached DM / conversation, opened and cached
 * on first use. Only for a CONFIRMED identity — an unconfirmed one has no
 * target at all.
 */
export async function resolveTarget(
  identity: { id: string; externalUserId: string; dmChannelId: string | null; conversationRef: unknown; verifiedAt: Date | null },
  client: ChatPlatformClient,
  token: string,
): Promise<ChatTarget> {
  if (!identity.verifiedAt) throw new IdentityError('forbidden');
  if (identity.dmChannelId) return { id: identity.dmChannelId, conversationRef: identity.conversationRef };
  const opened = await client.openDm({ token, externalUserId: identity.externalUserId, conversationRef: identity.conversationRef });
  await prisma.chatIdentity.update({ where: { id: identity.id }, data: { dmChannelId: opened.id.slice(0, 128) } });
  return { id: opened.id, conversationRef: identity.conversationRef };
}
