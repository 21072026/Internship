// Survey invitation links (#1881) — server-only. The token in the link is the
// credential; the database keeps only its SHA-256 hash
// (SurveyInvitation.tokenHash, minted by mintSurveyToken in src/lib/surveys.ts).
//
// Why a random token looked up by its hash, and not an HMAC over the
// invitation id like the newsletter links: an invitation is single-use and
// must be revocable. A random 256-bit token whose hash is the only copy cannot
// be re-derived by anyone holding the server secret, cannot be guessed, and is
// revoked by deleting one row — the TrustedDevice discipline, already in this
// tree, rather than a third scheme.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashSurveyToken, mintSurveyToken } from '@/lib/surveys';

export const SURVEY_INVITE_TTL_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** Base64url, as mintSurveyToken produces — anything else is not one of ours. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export function surveyInviteUrl(token: string, origin?: string | null): string {
  const base = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${base}/s/${token}`;
}

/**
 * Invite one person. Returns the token exactly once — it is not stored — or
 * null when this address is already invited to this survey (one person, one
 * invitation: @@unique([surveyId, email]); per round once the unique is
 * widened — see SurveyInvitation.round).
 */
export async function createSurveyInvitation(input: {
  surveyId: string;
  orgId: string | null;
  email: string;
  userId?: string | null;
  locale?: string | null;
  ttlDays?: number;
  /** A recurring campaign's period; "" for a one-off. */
  round?: string;
  now?: Date;
}): Promise<{ invitationId: string; token: string } | null> {
  const { token, tokenHash } = mintSurveyToken();
  const now = input.now ?? new Date();
  try {
    const invitation = await prisma.surveyInvitation.create({
      data: {
        surveyId: input.surveyId,
        orgId: input.orgId,
        email: input.email.trim().toLowerCase(),
        userId: input.userId ?? null,
        locale: input.locale ?? null,
        tokenHash,
        round: input.round ?? '',
        expiresAt: new Date(now.getTime() + (input.ttlDays ?? SURVEY_INVITE_TTL_DAYS) * DAY),
      },
      select: { id: true },
    });
    return { invitationId: invitation.id, token };
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') return null;
    throw error;
  }
}

const INVITATION_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  locale: true,
  respondedAt: true,
  expiresAt: true,
  user: { select: { role: true, preferredLanguage: true, isActive: true } },
  survey: {
    select: {
      id: true,
      title: true,
      intro: true,
      anonymity: true,
      status: true,
      opensAt: true,
      closesAt: true,
      questions: { orderBy: { sortOrder: 'asc' }, select: { key: true, type: true, labels: true, helpText: true, options: true, required: true } },
    },
  },
} satisfies Prisma.SurveyInvitationSelect;

export type ResolvedInvitation = Prisma.SurveyInvitationGetPayload<{ select: typeof INVITATION_SELECT }>;

/** null for a token that is not ours or names no invitation; 'expired' past its date. */
export async function resolveSurveyInvitation(token: string, now = new Date()): Promise<ResolvedInvitation | 'expired' | null> {
  if (!TOKEN_RE.test(token)) return null;
  const invitation = await prisma.surveyInvitation.findUnique({ where: { tokenHash: hashSurveyToken(token) }, select: INVITATION_SELECT });
  if (!invitation) return null;
  if (invitation.expiresAt <= now && !invitation.respondedAt) return 'expired';
  return invitation;
}
