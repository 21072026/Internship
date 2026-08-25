import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { UpcomingMeetingBanner } from '@/components/UpcomingMeetingBanner';
import { UpcomingMeetings } from '@/components/UpcomingMeetings';
import { MentorshipRequestPanel } from '@/components/MentorshipRequestPanel';
import { OfferCard } from '@/components/OfferCard';
import { JourneyTracker } from '@/components/JourneyTracker';
import { AnnouncementsCard } from '@/components/AnnouncementsCard';
import { ReferralLinkCard } from '@/components/ReferralLinkCard';
import { PortalTabs } from '@/components/PortalTabs';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/Badge';
import { User, Building2, ExternalLink, MessageCircle, FolderKanban, ArrowRight, Route } from 'lucide-react';
import Link from 'next/link';
import { formatDate } from '@/lib/relativeTime';
import { loadMenteeProjects } from '@/lib/menteeProjects';
import { missingRequirementsForUser } from '@/lib/documentRequirements';
import type { Locale } from '@/i18n/config';
import { FileWarning } from 'lucide-react';
import { PersonHoverCard } from '@/components/PersonHoverCard';

// #916: the dashboard is a SUMMARY. The heavier panels live on sub-routes so
// deep links and the back button work and the phone page stays short:
//   /portal/journey  — JourneyTracker + full mentorship card (company, interactions)
//   /portal/goals    — GoalsPanel · EvaluationPanel · WeeklyReportsPanel · InterviewPrep
//   /portal/requests — QuestionsPanel · MeetingRequestsPanel
// NotesPanel lives ONLY on /portal/notes now (it used to render twice), and the
// read-only profile card moved out entirely — /portal/profile is the profile.
async function getMenteeData(menteeId: string, locale: Locale) {
  const [user, activeRelation, visibilityConsent, projects, missingDocuments] = await Promise.all([
    prisma.user.findUnique({
      where: { id: menteeId },
      select: { university: true, skills: true },
    }),
    prisma.mentorshipRelation.findFirst({
      where: { menteeId, status: 'ACTIVE' },
      select: {
        id: true,
        status: true,
        startDate: true,
        pipelineStatus: true,
        mentor: { select: { id: true, fullName: true, publicProfile: true } },
      },
    }),
    // Has the mentee ever decided on company visibility (#527)? A row means
    // decided (granted OR revoked) — the nudge below only targets the undecided.
    prisma.userConsent.findUnique({
      where: { userId_type: { userId: menteeId, type: 'TALENT_POOL_VISIBILITY' } },
      select: { id: true },
    }),
    // The projects this mentee is on (#1114). Loaded separately rather than as
    // `activeRelation.project`, because membership can also come from a
    // ProjectMember row with no relation behind it — see lib/menteeProjects.ts.
    loadMenteeProjects(menteeId, 3),
    missingRequirementsForUser(menteeId, locale),
  ]);

  return { user, activeRelation, visibilityDecided: !!visibilityConsent, projects, missingDocuments };
}

export default async function PortalDashboard() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t, locale } = await getServerDictionary();
  const { user, activeRelation, visibilityDecided, projects, missingDocuments } = await getMenteeData(session.user.id, locale);

  const profileComplete = user?.university && user?.skills && (user.skills as string[]).length > 0;

  return (
    <div>
      <OnboardingChecklist />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t.portal.welcome}, {session.user.name}!
        </h1>
        <p className="text-gray-500 mt-1">{t.portal.dashSubtitle}</p>
      </div>

      <PortalTabs />

      {/* Half an hour before a meeting, and for as long as it runs (#51 follow-up). */}
      <UpcomingMeetingBanner />

      {/* "Invite your circle" (#51): anyone who signs up through this link is
          credited to this mentee as their source. */}
      <ReferralLinkCard />

      {missingDocuments.length > 0 && (
        <Card className="mb-6 border-amber-200 dark:border-amber-800" data-testid="missing-documents-card">
          <CardHeader><div className="flex items-center gap-2"><FileWarning className="h-5 w-5 text-amber-600 dark:text-amber-400" /><CardTitle>{t.documentRequirements.portalTitle}</CardTitle></div></CardHeader>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{t.documentRequirements.portalHint}</p>
          <ul className="mb-4 list-disc pl-5 text-sm text-gray-800 dark:text-gray-200">{missingDocuments.map((requirement) => <li key={requirement.id}>{requirement.label}</li>)}</ul>
          <Link href="/portal/profile#documents" className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700">{t.documentRequirements.uploadCta}</Link>
        </Card>
      )}

      {!profileComplete && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-xl flex items-center justify-between">
          <div>
            <p className="font-medium text-yellow-800">{t.portal.completeProfile}</p>
            <p className="text-sm text-yellow-600 mt-0.5">
              {t.portal.completeProfileHint}
            </p>
          </div>
          <Link
            href="/onboarding"
            className="bg-yellow-400 text-gray-900 dark:!text-gray-900 px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-300 transition-colors flex-shrink-0 ml-4"
          >
            {t.portal.completeProfileCta}
          </Link>
        </div>
      )}

      {/* Company-visibility nudge (#527): shown only while the mentee has never
          decided on the TALENT_POOL_VISIBILITY consent. Granting OR declining
          in Account settings makes it disappear — no nagging after a decision. */}
      {!visibilityDecided && (
        <div data-testid="visibility-nudge" className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between dark:bg-blue-900/20 dark:border-blue-800">
          <div>
            <p className="font-medium text-blue-800 dark:text-blue-200">{t.portal.visibilityNudge}</p>
            <p className="text-sm text-blue-600 dark:text-blue-300 mt-0.5">{t.portal.visibilityNudgeHint}</p>
          </div>
          <Link
            href="/account"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex-shrink-0 ml-4"
          >
            {t.portal.visibilityNudgeCta}
          </Link>
        </div>
      )}

      {!activeRelation && <MentorshipRequestPanel />}

      {/* Offer card (#809) — kept above the fold: an offer needing a decision is
          the single most time-sensitive thing a mentee can see here. */}
      {activeRelation && (
        <div className="mb-6">
          <OfferCard />
        </div>
      )}

      {/* Journey / pipeline stage — the "where am I" strip stays on the summary
          (#692); the full mentorship detail lives on /portal/journey. */}
      {activeRelation && (
        <div className="mb-6">
          <JourneyTracker status={activeRelation.pipelineStatus} />
        </div>
      )}

      {/* Upcoming meetings (#914): when is my meeting, what's the link —
          answered on the first screen, with in-app RSVP and .ics download. */}
      <UpcomingMeetings />

      {/* Compact mentor card: who my mentor is + the two actions a mentee
          reaches for daily. Company details and the interaction history moved
          to /portal/journey. */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <CardTitle>{t.portal.myMentorship}</CardTitle>
          </div>
        </CardHeader>
        {!activeRelation ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <User className="h-8 w-8 text-gray-400" />
            </div>
            <p className="text-gray-500 font-medium">{t.portal.noMentor}</p>
            <p className="text-sm text-gray-400 mt-1">
              {t.portal.noMentorHint}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge status={activeRelation.status} />
              <span className="text-xs text-gray-400">
                {t.portal.since} {formatDate(activeRelation.startDate, locale)}
              </span>
            </div>
            <div className="p-4 bg-blue-50 rounded-xl">
              <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-2">
                {t.portal.yourMentor}
              </p>
              <p className="font-semibold text-gray-900">
                <PersonHoverCard personId={activeRelation.mentor.id} name={activeRelation.mentor.fullName} role="MENTOR" />
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/messages/${activeRelation.id}`} className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
                  <MessageCircle className="h-4 w-4" />
                  {t.portal.messageMentor}
                </Link>
                <Link href="/portal/journey" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
                  <Route className="h-4 w-4" />
                  {t.portal.tabs.journey}
                </Link>
                {activeRelation.mentor.publicProfile === true && (
                  <Link href={`/p/${activeRelation.mentor.id}`} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
                    <ExternalLink className="h-4 w-4" />
                    {t.portal.viewMentorProfile}
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Projects (#1114). Outside the mentorship card on purpose: a mentee can
          be a project member without an active relation, and hiding the card in
          that branch would reproduce the invisibility this fixes. */}
      {projects.length > 0 && (
        <div className="mt-6">
          <Card data-testid="portal-projects-card">
            <CardHeader className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FolderKanban className="h-5 w-5 text-blue-600" />
                {t.portal.projects.title}
              </CardTitle>
              <Link href="/portal/projects" className="text-sm text-blue-600 hover:underline">
                {t.portal.projects.viewAll}
              </Link>
            </CardHeader>
            <div className="space-y-2">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-3 p-3 rounded-xl bg-blue-50 hover:bg-blue-100 transition-colors"
                  data-testid={`portal-dashboard-project-${p.id}`}
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{p.name}</p>
                    {p.owner && (
                      <p className="text-xs text-gray-500">
                        {t.projects.by} {p.owner}
                      </p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-blue-600 ml-auto flex-shrink-0" />
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6">
        <AnnouncementsCard />
      </div>
    </div>
  );
}
