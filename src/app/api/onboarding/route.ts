import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { orgScoped, resolveOrgId } from '@/lib/orgScope';
import { checklistGuidanceKey, isGuidanceDismissed } from '@/lib/guidance';

// GET — role-aware first-run checklist state for the current user.
// Returns ordered steps with { key, done, href, optional?, guideKey } plus the
// server-side `dismissed` flag (UserGuidanceState, keyed `checklist:<ROLE>`).
//
// Every `done` is DERIVED from a count or a column: nothing here stores "the
// user says they did this", so the checklist can never claim a step is finished
// when the rows that prove it are gone. `guideKey` names the localised
// explanation the UI opens behind the step; it equals the step key today, but
// is sent explicitly so two steps could share one guide later.

interface Step {
  key: string;
  done: boolean;
  href: string;
  optional?: boolean;
  guideKey: string;
}

// Attach the guide key to a step. One place, so a new step cannot ship without
// one (and `npm run check:i18n` then catches a guide missing in TR or DE).
function withGuides(steps: Omit<Step, 'guideKey'>[]): Step[] {
  return steps.map((s) => ({ ...s, guideKey: s.key }));
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id, role } = session.user;
    const dismissed = await isGuidanceDismissed(id, checklistGuidanceKey(role));

    if (role === 'MENTEE') {
      const user = await prisma.user.findUnique({
        where: { id },
        select: { university: true, skills: true, publicProfile: true, cvFile: { select: { id: true } } },
      });
      const skills = Array.isArray(user?.skills) ? (user!.skills as unknown[]) : [];
      return NextResponse.json({
        role,
        dismissed,
        steps: withGuides([
          { key: 'profile', done: !!(user?.university && skills.length > 0), href: '/portal/profile' },
          { key: 'cv', done: !!user?.cvFile, href: '/portal/profile' },
          { key: 'public', done: !!user?.publicProfile, href: '/portal/profile' },
        ]),
      });
    }

    if (role === 'MENTOR') {
      const [user, availabilitySlots] = await Promise.all([
        prisma.user.findUnique({
          where: { id },
          select: { bio: true, interests: true, skills: true, mentorCapacity: true },
        }),
        prisma.availabilitySlot.count({ where: { mentorId: id } }),
      ]);
      const skills = Array.isArray(user?.skills) ? (user!.skills as unknown[]) : [];
      return NextResponse.json({
        role,
        dismissed,
        steps: withGuides([
          { key: 'bio', done: !!user?.bio?.trim(), href: '/mentor/profile' },
          { key: 'interestsOrSkills', done: !!user?.interests?.trim() || skills.length > 0, href: '/mentor/profile' },
          { key: 'mentorCapacity', done: user?.mentorCapacity != null, href: '/mentor/profile' },
          { key: 'availability', done: availabilitySlots > 0, href: '/mentor/availability' },
        ]),
      });
    }

    if (role === 'ADMIN') {
      // The launch list a programme owner actually has to work through, not the
      // three rows the dashboard happened to have. StageSla / PipelineStage /
      // DocumentRequirement / EvaluationTemplate carry a REQUIRED orgId and are
      // not tenant-anchored by the central middleware, so they are scoped here
      // the way their own admin routes do it (resolveOrgId + an explicit where).
      const orgId = resolveOrgId(session);
      const [
        stages,
        slas,
        documentRequirements,
        evaluationTemplates,
        mentors,
        mentees,
        companies,
        relations,
        interactions,
      ] = await Promise.all([
        orgId ? prisma.pipelineStage.count({ where: { orgId } }) : Promise.resolve(0),
        orgId ? prisma.stageSla.count({ where: { orgId } }) : Promise.resolve(0),
        orgId ? prisma.documentRequirement.count({ where: { orgId } }) : Promise.resolve(0),
        orgId ? prisma.evaluationTemplate.count({ where: { orgId, active: true } }) : Promise.resolve(0),
        prisma.user.count({ where: orgScoped({ role: 'MENTOR' as const }, orgId) }),
        prisma.user.count({ where: orgScoped({ role: 'MENTEE' as const }, orgId) }),
        prisma.company.count(),
        prisma.mentorshipRelation.count(),
        prisma.interactionLog.count(),
      ]);
      return NextResponse.json({
        role,
        dismissed,
        steps: withGuides([
          // Optional: custom stages are a premium feature and the built-in
          // pipeline is a perfectly good answer, so an org that keeps the
          // defaults must not be held one step short for ever. There is no
          // stored "I accepted the defaults" flag — that would be exactly the
          // self-reported progress the rest of this list avoids.
          {
            key: 'configurePipeline',
            done: stages > 0,
            href: orgId ? `/admin/organizations/${orgId}/pipeline` : '/admin/organizations',
            optional: true,
          },
          { key: 'setStageSlas', done: slas > 0, href: '/admin/settings' },
          { key: 'documentRequirements', done: documentRequirements > 0, href: '/admin/documents' },
          { key: 'evaluationTemplate', done: evaluationTemplates > 0, href: '/admin/settings' },
          { key: 'inviteMentors', done: mentors > 0, href: '/admin/invite' },
          { key: 'inviteMentees', done: mentees > 0, href: '/admin/invite' },
          { key: 'addCompany', done: companies > 0, href: '/admin/companies' },
          { key: 'assignMentorship', done: relations > 0, href: '/admin/mentorship' },
          // Optional for the same reason the mentor's "schedule a meeting" is:
          // the first logged conversation is a milestone, not a setup task, and
          // it must never keep the card open once the setup is finished.
          { key: 'firstInteraction', done: interactions > 0, href: '/admin/mentorship', optional: true },
        ]),
      });
    }

    return NextResponse.json({ role, dismissed, steps: [] });
  });
}
