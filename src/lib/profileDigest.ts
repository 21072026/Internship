/**
 * The profile digest's writer (#2038) — the ONE place a `ProfileDigest` row is
 * created, replaced or removed. Server-only. The rules are pure in
 * `src/lib/profileDigestRule.ts`; the model call in `src/lib/ai/profileDigest.ts`.
 *
 * Every refresh reads the person's own text, hashes it, and only calls the
 * model when that hash differs from the stored one (or the person asked for a
 * regeneration). The call goes through `runAiGated` — the org's AI switches,
 * the AI pack, the quota and the person's own `AI_CV_PARSING` consent all
 * decide — and any refusal leaves the stored digest as it was: matching keeps
 * working on the deterministic rules, with or without one.
 *
 * Only the person's OWN goals contribute (goals they created themselves): a
 * goal their mentor wrote is the mentor's text, and a PRIVATE goal of
 * somebody else must never ride into a summary of this person.
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { runAiGated } from '@/lib/aiGate';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { generateProfileDigest } from '@/lib/ai/profileDigest';
import { DIGEST_SCAN_LIMIT, DIGEST_SWEEP_BATCH, digestSourceText, planDigestRefresh } from '@/lib/profileDigestRule';
import { resolveModel } from '@/lib/ai/provider';

export type DigestRefresh =
  | { status: 'updated' | 'unchanged' | 'removed' | 'empty' }
  | { status: 'denied'; reason: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function refreshProfileDigest(userId: string, opts: { force?: boolean; touch?: boolean } = {}): Promise<DigestRefresh> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, orgId: true, bio: true, interests: true, targetPosition: true, skills: true, profileDigest: { select: { sourceHash: true } } },
  });
  if (!user) return { status: 'denied', reason: 'missing' };
  const goals = await prisma.goal.findMany({
    where: { createdById: userId, relation: { OR: [{ menteeId: userId }, { mentorId: userId }] } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { title: true },
  });
  const text = digestSourceText({ ...user, goalTitles: goals.map((g) => g.title) });
  const sourceHash = text ? sha256(text) : null;
  const plan = planDigestRefresh(sourceHash, user.profileDigest?.sourceHash ?? null, opts.force);

  if (plan === 'remove') {
    await prisma.profileDigest.deleteMany({ where: { userId } });
    return { status: 'removed' };
  }
  if (plan === 'unchanged') {
    // The sweep marks a checked digest as checked (`@updatedAt`), so the
    // next night starts with somebody else instead of the same oldest rows.
    if (opts.touch && sourceHash !== null) await prisma.profileDigest.updateMany({ where: { userId }, data: { sourceHash } });
    return { status: sourceHash === null ? 'empty' : 'unchanged' };
  }

  const gated = await runAiGated({
    scope: 'profile_digest',
    consent: { userId, type: 'AI_CV_PARSING' },
    orgId: await settingsOrgOfRow(user.orgId),
    userId,
    call: () => generateProfileDigest(text),
  });
  if (!gated.ok) return { status: 'denied', reason: gated.reason };
  if (!gated.result) return { status: 'denied', reason: 'unusable_reply' };

  const data = { digest: gated.result.digest, themes: gated.result.themes, sourceHash: sourceHash!, model: resolveModel('profile_digest') };
  await prisma.profileDigest.upsert({
    where: { userId },
    create: { ...data, userId, orgId: user.orgId },
    update: data,
  });
  return { status: 'updated' };
}

/**
 * The nightly sweep (job `profileDigest.refresh`): consenting, active MENTORs
 * and MENTEEs: those with no digest and those with the longest-unchecked one.
 * Checking a person costs two reads and no call — an unchanged text is
 * `unchanged` — so the scan is wide (`DIGEST_SCAN_LIMIT`) while the model is asked at most
 * `DIGEST_SWEEP_BATCH` times a night. An org whose AI is off, unpaid or out of
 * quota is skipped for the rest of the run, silently: that is not an error.
 */
export async function runProfileDigestSweep(): Promise<Record<string, number>> {
  const eligible = {
    isActive: true,
    role: { in: ['MENTOR' as const, 'MENTEE' as const] },
    consents: { some: { type: 'AI_CV_PARSING' as const, grantedAt: { not: null }, revokedAt: null } },
  };
  // Two halves, so neither can starve the other: people with no digest yet,
  // the most recently edited first (a profile just filled in rises to the
  // top), and people with one, the longest unchecked first.
  const half = Math.floor(DIGEST_SCAN_LIMIT / 2);
  const [fresh, stale] = await Promise.all([
    prisma.user.findMany({ where: { ...eligible, profileDigest: { is: null } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: half, select: { id: true, orgId: true } }),
    prisma.user.findMany({ where: { ...eligible, profileDigest: { isNot: null } }, orderBy: [{ profileDigest: { updatedAt: 'asc' } }, { id: 'asc' }], take: half, select: { id: true, orgId: true } }),
  ]);
  const candidates = [...fresh, ...stale];
  const out: Record<string, number> = { scanned: 0 };
  const closedOrgs = new Set<string | null>();
  let calls = 0;
  for (const c of candidates) {
    if (calls >= DIGEST_SWEEP_BATCH) break;
    if (closedOrgs.has(c.orgId)) continue;
    out.scanned += 1;
    const r = await refreshProfileDigest(c.id, { touch: true });
    const key = r.status === 'denied' ? `denied_${r.reason}` : r.status;
    out[key] = (out[key] ?? 0) + 1;
    if (r.status === 'updated' || (r.status === 'denied' && r.reason === 'provider_error')) calls += 1;
    if (r.status === 'denied' && ['disabled', 'not_entitled', 'quota_exceeded', 'not_configured'].includes(r.reason)) closedOrgs.add(c.orgId);
  }
  return out;
}
