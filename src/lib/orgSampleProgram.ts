// The starter pack's sample programme (#2066): a small, clearly labelled
// synthetic set inside a real tenant, so the first login does not open on
// empty screens — 1 company, 1 requisition, 2 mentors, 4 mentees spread over
// the pipeline, a few interactions and one weekly report.
//
// THE RULES
//   • Every row is tagged `sampleData: true` (User, Company,
//     MentorshipRelation, Requisition — the rest hangs off a relation and goes
//     with it), and `removeSampleProgram` deletes exactly those rows.
//   • Every name says "(sample)" and every address is `@sample.invalid`: the
//     .invalid TLD is reserved (RFC 2606), so no message to these people can
//     ever be delivered, whatever a later feature decides to send.
//   • Stages are the org's own, picked by position among its on-path stages —
//     never a hardcoded key (scripts/check-stage-keys.mjs, #1886).
//   • Idempotent: an org that already has sample rows gets nothing new.
//   • Internship only: a vertical without the `mentorship` capability has no
//     mentors or mentees to show, so it gets no sample programme.

import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { defaultPipelineStages } from '@/lib/pipeline';
import { verticalHasCapability } from '@/lib/verticals';
import { stageTrialWindow } from '@/lib/trialWindow';
import { utcWeekStart } from '@/lib/week';
import { hardDeleteUser } from '@/lib/accountErasure';

type Tx = Prisma.TransactionClient;

export const SAMPLE_EMAIL_DOMAIN = 'sample.invalid';
const DAY = 24 * 60 * 60 * 1000;

const MENTORS = ['Aylin Kaya', 'Jonas Weber'];
const MENTEES = ['Ada Demir', 'Ben Fischer', 'Ceren Yıldız', 'David Schmidt'];
/** Where each mentee stands: a position among the org's on-path stages (clamped). */
const STAGE_POSITIONS = [0, 2, 5, 8];

export interface SampleProgramResult {
  created: number;
  skipped: number;
}

const sampleEmail = (kind: string, n: number, orgId: string) => `sample-${kind}-${n}.${orgId}@${SAMPLE_EMAIL_DOMAIN}`;

/** Create the sample set inside the caller's transaction. */
export async function createSampleProgram(tx: Tx, orgId: string, now = new Date()): Promise<SampleProgramResult> {
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { vertical: true } });
  if (!org || !verticalHasCapability(org.vertical, 'mentorship')) return { created: 0, skipped: 0 };
  if (await tx.user.count({ where: { orgId, sampleData: true } })) return { created: 0, skipped: 1 };

  const own = await tx.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' }, select: { key: true, isTerminal: true, isOffPath: true } });
  const stages = own.length ? own : defaultPipelineStages();
  const onPath = stages.filter((s) => !s.isTerminal && !s.isOffPath);
  const stageAt = (i: number) => onPath[Math.min(i, onPath.length - 1)].key;

  const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
  let created = 0;
  const company = await tx.company.create({ data: { orgId, name: 'Northwind Labs (sample)', sampleData: true }, select: { id: true } });
  created++;
  // A requisition is a `placements` module row: only a vertical that has it gets one.
  if (verticalHasCapability(org.vertical, 'placements')) {
    await tx.requisition.create({ data: { orgId, companyId: company.id, title: 'Junior developer (sample)', status: 'OPEN', openings: 2, sampleData: true } });
    created++;
  }

  const mentorIds: string[] = [];
  for (const [i, name] of MENTORS.entries()) {
    const u = await tx.user.create({
      data: { orgId, email: sampleEmail('mentor', i + 1, orgId), fullName: `${name} (sample)`, role: 'MENTOR', password, mentorOnboardingSeenAt: now, sampleData: true },
      select: { id: true },
    });
    mentorIds.push(u.id);
    created++;
  }
  const relationIds: string[] = [];
  for (const [i, name] of MENTEES.entries()) {
    const mentee = await tx.user.create({
      data: { orgId, email: sampleEmail('mentee', i + 1, orgId), fullName: `${name} (sample)`, role: 'MENTEE', password, sampleData: true },
      select: { id: true },
    });
    const pipelineStatus = stageAt(STAGE_POSITIONS[i]);
    const startDate = new Date(now.getTime() - (60 - i * 10) * DAY);
    const rel = await tx.mentorshipRelation.create({
      data: {
        orgId,
        mentorId: mentorIds[i < 2 ? 0 : 1],
        menteeId: mentee.id,
        status: 'ACTIVE',
        pipelineStatus,
        startDate,
        ...(i === 2 ? { companyId: company.id } : {}),
        sampleData: true,
        ...(await stageTrialWindow({ orgId, toStage: pipelineStatus, enteredAt: startDate })),
      },
      select: { id: true },
    });
    relationIds.push(rel.id);
    created += 2;
  }

  await tx.interactionLog.createMany({
    data: [
      { relationId: relationIds[0], date: new Date(now.getTime() - 20 * DAY), type: 'Meeting', subject: 'Kick-off (sample)', notes: 'Agreed on three goals for the term and a weekly rhythm.' },
      { relationId: relationIds[1], date: new Date(now.getTime() - 12 * DAY), type: 'Feedback', subject: 'CV review (sample)', notes: 'Tightened the project section; added two measurable results.' },
      { relationId: relationIds[2], date: new Date(now.getTime() - 6 * DAY), type: 'Call', subject: 'Check-in (sample)', notes: 'First week at the host company went well; onboarding docs were outdated.' },
      { relationId: relationIds[3], date: new Date(now.getTime() - 3 * DAY), type: 'Email', subject: 'Interview prep (sample)', notes: 'Shared three practice questions for the technical round.' },
    ],
  });
  await tx.weeklyReport.create({
    data: {
      orgId,
      relationId: relationIds[2],
      weekStart: utcWeekStart(new Date(now.getTime() - 7 * DAY)),
      summary: 'Set up the local environment and shipped a first small fix (sample).',
      blockers: 'VPN access took two days (sample).',
      hoursSpent: 32,
      status: 'SUBMITTED',
      submittedAt: new Date(now.getTime() - 3 * DAY),
    },
  });
  created += 5;
  return { created, skipped: 0 };
}

export interface SampleRemoval {
  relations: number;
  requisitions: number;
  users: number;
  companies: number;
}

/**
 * Remove exactly the sample rows of one org. Relations first (their logs,
 * reports and moves go with them), then requisitions, then the sample people
 * — through the same hard delete account erasure uses, so anything a real
 * admin did with them since (a message, a note) does not block the delete —
 * and last the sample companies. A row without `sampleData` is never touched.
 */
export async function removeSampleProgram(orgId: string): Promise<SampleRemoval> {
  const relations = await prisma.mentorshipRelation.deleteMany({ where: { orgId, sampleData: true } });
  const requisitions = await prisma.requisition.deleteMany({ where: { orgId, sampleData: true } });
  const people = await prisma.user.findMany({ where: { orgId, sampleData: true }, select: { id: true } });
  for (const p of people) await hardDeleteUser(p.id);
  const companies = await prisma.company.deleteMany({ where: { orgId, sampleData: true } });
  return { relations: relations.count, requisitions: requisitions.count, users: people.length, companies: companies.count };
}
