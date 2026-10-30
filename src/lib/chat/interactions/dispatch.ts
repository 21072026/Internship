import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { appOriginForOrg } from '@/lib/orgLinkOrigin';
import type { InteractionEnvelope } from './envelope';
import type { ChatPlatform } from '@prisma/client';

// The ONE dispatcher behind the chat interaction endpoint (#1948). The route
// has already verified the platform's signature; everything in the envelope is
// still a claim, so the person is re-derived here, every time:
//
//   (platform, teamId) → an ENABLED ChatWorkspace
//   (workspace, externalUserId) → a ChatIdentity the person CONFIRMED (verifiedAt)
//   → its User, active, in the workspace's org
//
// Only then does a registered handler run, inside runWithOrg(user's org), and
// it receives the resolved user — never a payload id. A member with no
// confirmed identity gets the "link your account first" reply and NOTHING
// else: no handler runs, not even a read. An unknown action is the same
// opaque "no longer available" whoever asks, so the registry cannot be probed.
//
// A handler is a read or a write the person could do in the app; it must ask
// the same rules the app's routes ask (no second authorization path) and say
// why a rerun is harmless — platforms retry on a slow ack.

export interface ChatActor {
  id: string;
  role: string;
  orgId: string | null;
  locale: Locale;
  timeZone: string | null;
}

export interface ChatActionContext {
  user: ChatActor;
  platform: ChatPlatform;
  workspaceId: string;
  identityId: string;
  /** The button's opaque value; the handler validates it. */
  value: string | null;
}

export interface ChatReply {
  text: string;
}

export type ChatActionHandler = (ctx: ChatActionContext) => Promise<ChatReply>;

const registry = new Map<string, ChatActionHandler>();

/** Register an action id. A second registration of the same id is a programming error. */
export function registerChatAction(actionId: string, handler: ChatActionHandler): void {
  if (registry.has(actionId)) throw new Error(`chat action already registered: ${actionId}`);
  registry.set(actionId, handler);
}

export function registeredChatActions(): string[] {
  return [...registry.keys()].sort();
}

export type DispatchOutcome =
  | { kind: 'handled'; actionId: string; reply: ChatReply }
  | { kind: 'unlinked'; reply: ChatReply }
  | { kind: 'unknown_action'; reply: ChatReply }
  | { kind: 'failed'; reply: ChatReply };

function langOf(v: string | null | undefined): Locale {
  return isLocale(v) ? v : defaultLocale;
}

/** Who is clicking, re-derived from the verified identity; null when there is no such person. */
async function resolveActor(platform: ChatPlatform, env: InteractionEnvelope) {
  const ws = await prisma.chatWorkspace.findUnique({
    where: { platform_externalId: { platform, externalId: env.teamId } },
    select: { id: true, orgId: true, enabled: true },
  });
  if (!ws) return { ws: null, actor: null };
  if (!ws.enabled) return { ws, actor: null };
  const identity = await prisma.chatIdentity.findUnique({
    where: { workspaceId_externalUserId: { workspaceId: ws.id, externalUserId: env.externalUserId } },
    select: {
      id: true,
      verifiedAt: true,
      user: { select: { id: true, role: true, orgId: true, isActive: true, preferredLanguage: true, timezone: true } },
    },
  });
  const u = identity?.user;
  if (!identity?.verifiedAt || !u || !u.isActive) return { ws, actor: null };
  // A workspace installed for one org never acts for a person of another.
  if (ws.orgId && u.orgId !== ws.orgId) return { ws, actor: null };
  const actor: ChatActor = { id: u.id, role: u.role, orgId: u.orgId, locale: langOf(u.preferredLanguage), timeZone: u.timezone };
  return { ws, actor, identityId: identity.id };
}

export async function dispatchInteraction(platform: ChatPlatform, env: InteractionEnvelope): Promise<DispatchOutcome> {
  let locale: Locale = defaultLocale;
  try {
    const { ws, actor, identityId } = await resolveActor(platform, env);
    if (!actor || !ws || !identityId) {
      const t = getDictionary(locale).chatInteraction;
      const origin = await appOriginForOrg(ws?.orgId ?? null);
      return { kind: 'unlinked', reply: { text: `${t.unlinked}\n${origin}/account` } };
    }
    locale = actor.locale;
    const t = getDictionary(locale).chatInteraction;
    const handler = registry.get(env.actionId);
    if (!handler) return { kind: 'unknown_action', reply: { text: t.unavailable } };
    const reply = await runWithOrg(actor.orgId, () =>
      handler({ user: actor, platform, workspaceId: ws.id, identityId, value: env.value }),
    );
    return { kind: 'handled', actionId: env.actionId, reply };
  } catch (e) {
    logger.error('chat interaction failed', { actionId: env.actionId, error: String(e) });
    return { kind: 'failed', reply: { text: getDictionary(locale).chatInteraction.failed } };
  }
}
