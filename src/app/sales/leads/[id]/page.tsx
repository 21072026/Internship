import Link from 'next/link';
import { ATTEMPT_INTERACTION_WHERE } from '@/lib/interactionOutcome';
import { AffiliateSourceBadge } from '@/components/AffiliateSourceBadge';
import { affiliatePartnerNames, affiliatePartnerNameFor } from '@/lib/affiliateLeadSource';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { formatInTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { isSalesDispatcher } from '@/lib/salesDispatcher';
import { salesBookWhere, salesTeamReadWhere } from '@/lib/salesBookRule';
import { canWriteSalesRecord, salesTeamReadAllowed } from '@/lib/salesBook';
import { canSeeNextAction } from '@/lib/nextActionRule';
import { getLastContacts } from '@/lib/lastContact';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import { getServerDictionary } from '@/i18n/server';
import { getDictionary } from '@/i18n/dictionaries';
import { locales } from '@/i18n/config';
import { followUpInteractionType, handoffActionFromNote, handoffNoteText, isHandoffAction } from '@/lib/leadHandoffRule';
import { Card, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SalesRecordPanels } from '@/components/sales/SalesRecordPanels';
import { PlanMeetingButton } from '@/app/sales/calendar/PlanMeetingDialog';
import { SalesInteractionsCard, type LeadSystemEvent } from '@/components/sales/SalesInteractionsCard';
import { LeadContactEditor } from '@/components/sales/LeadContactEditor';
import { shownEmail } from '@/lib/leadEmail';
import { LeadPageHandoff } from '@/components/sales/LeadPageHandoff';
import { earlierPeriods, currentSuccessor } from '@/lib/leadJourney';
import { followUpEventsFor, type FollowUpEventView } from '@/lib/followUpEvents';
import { markAssignmentSeen } from '@/lib/assignedToYou';
import { RefreshRouterCache } from '@/components/RefreshRouterCache';

// One of the rep's own records (#2580): who the lead is, the account behind it,
// its stage, the follow-up, trial-end and estimated-value (#2422) editors, what happened last and a
// form to log the next call or meeting. The follow-up (what comes next) and the
// interactions (what already happened) sit side by side at the top (#3737).
//
// Found as `id AND the rep's tenant AND` the viewer's read: their own book
// (`mentorId = self`; any owner for the sales dispatcher, #3656), or — while
// the team read is allowed (src/lib/salesBookRule.ts: an admin, the dispatcher,
// a rep while the org's `salesTeamBookForReps` is on) — any record of the org.
// Another tenant's record, an id that does not exist, or a colleague's while
// the team read is off are the same 404 (no loading.tsx above this page, so
// notFound() is the status line too).
//
// Whether the viewer may WORK it is a separate answer (canWriteSalesRecord):
// for anyone else the page is read-only — a banner names the owner (with a way
// to message them), no editor renders, and the owner's own data stays the
// owner's: the contact's e-mail and phone, the follow-up and the notice period
// (canSeeNextAction), the deal value. The routes re-check ownership on every
// write anyway.
const INTERACTION_LIMIT = 20;

function Field({ label, value, hint, testId }: { label: string; value?: string | null; hint?: string; testId?: string }) {
  if (!value) return null;
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100 break-words">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-gray-500">{hint}</dd>}
    </div>
  );
}

export default async function SalesLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) notFound();
  const capabilities = await shellCapabilities(session.user.orgId);
  if (!hasSalesSurface(session.user.role, capabilities)) notFound();

  const tenant = await tenantWhere(session);
  const [dispatcher, teamRead] = await Promise.all([isSalesDispatcher(session.user.id), salesTeamReadAllowed(session)]);
  const read = teamRead ? salesTeamReadWhere(true) : salesBookWhere({ userId: session.user.id, dispatcher });
  const relation = await prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id, ...read }, tenant),
    select: {
      id: true,
      orgId: true,
      mentorId: true,
      menteeId: true,
      cohortId: true,
      mentor: { select: { fullName: true } },
      status: true,
      pipelineStatus: true,
      startDate: true,
      nextActionAt: true,
      nextActionNote: true,
      nextActionTime: true,
      nextActionType: true,
      trialStartedAt: true,
      trialEndsAt: true,
      contractEndsAt: true,
      // The record's estimated monthly value (#2422) — its own row, read by
      // name here and on the owner/ADMIN value route only.
      value: { select: { valueMinor: true, currency: true, source: true } },
      mentee: { select: { id: true, fullName: true, email: true, phone: true, source: { select: { name: true } } } },
      // Through the tenant filter too: a record pointing at another tenant's
      // company (a bad import) shows no account rather than a foreign one.
      companyId: true,
      previousRelationId: true,
    },
  });
  if (!relation) notFound();
  // The owner opened it: it leaves their "Assigned to you" card (#3874). Not
  // under impersonation — an admin looking over the rep's shoulder has not seen it for them.
  // When this visit is the one that marked it, the client router cache still
  // holds /sales and /sales/board with the card on them — a Back press would
  // show that copy (#3894) — so the page drops the cache once.
  const justSeen =
    relation.mentorId === session.user.id && !session.user.impersonatorId
      ? await markAssignmentSeen(relation.id, session.user.id)
      : false;
  // Who may WORK this record — every editor below, the hand-off (#3657), the
  // contact log (#3748), the trial end: the rule the write routes apply.
  const writable = await canWriteSalesRecord(session, relation);
  const ownersView = writable || canSeeNextAction({ id: session.user.id, role: session.user.role }, relation);

  const [company, lastContact, interactions, earlier, successor, followUpEvents, stageMoves, meetings, viewer, attemptCount] = await Promise.all([
    relation.companyId
      ? prisma.company.findFirst({
          where: withinTenant({ id: relation.companyId }, tenant),
          // The account's primary contact IS the lead's contact (#3655): the lead
          // row carries a stand-in address (src/lib/leadEmail.ts).
          select: { id: true, name: true, industry: true, contactName: true, contactEmail: true, contactPhone: true, contactPosition: true },
        })
      : null,
    getLastContacts([{ id: relation.id, menteeId: relation.menteeId }]).then((m) => m.get(relation.id)?.at ?? null),
    prisma.interactionLog.findMany({
      where: { relationId: relation.id },
      orderBy: { date: 'desc' },
      take: INTERACTION_LIMIT,
      select: { id: true, date: true, type: true, subject: true, notes: true, outcome: true },
    }),
    earlierPeriods(relation),
    relation.status === 'ACTIVE' ? null : currentSuccessor(relation),
    // The follow-up's history (#3819) carries the owner's notes: only for the
    // viewers who may read the follow-up itself.
    ownersView ? followUpEventsFor(relation.id) : [],
    // The stage history (#3820), read from the audit rows every stage move
    // already writes — no second record. Stages are on the page for every
    // reader; the reason note is not shown here.
    prisma.statusChange.findMany({
      where: { relationId: relation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: INTERACTION_LIMIT,
      select: { id: true, fromStatus: true, toStatus: true, createdAt: true, changedBy: { select: { fullName: true } } },
    }),
    // Meetings planned on this record (#3837), read from the Meeting rows the
    // planner already writes — no InteractionLog row: planning a meeting is
    // not a contact (the last-contact rule, the counters and the billing meter
    // read that log; same reasoning as #3819).
    prisma.meeting.findMany({
      where: { relationId: relation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: INTERACTION_LIMIT,
      select: { id: true, title: true, scheduledAt: true, createdAt: true, createdById: true, status: true, cancelledAt: true, cancelledById: true },
    }),
    // A meeting's time reads in the viewer's own zone.
    prisma.user.findUnique({ where: { id: session.user.id }, select: { timezone: true } }),
    // How often this lead was tried and not reached (#3902), over every row, not only the listed ones.
    prisma.interactionLog.count({ where: { relationId: relation.id, ...ATTEMPT_INTERACTION_WHERE } }),
  ]);
  // The earlier owners' follow-up history (#3870) — under the same gate as this
  // record's: the notes are working prose, shown only to who may read the follow-up.
  const earlierFollowUps = await Promise.all(earlier.map((p) => (ownersView ? followUpEventsFor(p.relationId) : [])));
  // The banner's link only when this viewer may open the current record (the same read as this page).
  const successorOpens =
    !!successor &&
    !!(await prisma.mentorshipRelation.findFirst({ where: withinTenant({ id: successor.relationId, ...read }, tenant), select: { id: true } }));

  const { locale, t } = await getServerDictionary();
  const s = t.sales.lead;
  const stages = await resolvePipelineStages(session.user.orgId, locale);
  const date = (value: Date) => formatDate(value, locale);
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  // One follow-up as a phrase: its day, its note, or both.
  const followUpText = (at: Date | null, note: string | null) =>
    [at ? date(at) : null, note].filter(Boolean).join(' — ') || s.followUpEvent.noDate;
  const followUpLine = (e: FollowUpEventView): LeadSystemEvent => {
    const someone = s.followUpEvent.someone;
    const fill = (tpl: string, from: string, to: string) => tpl.replace('{from}', () => from).replace('{to}', () => to);
    const headline =
      e.kind === 'ASSIGNED'
        ? fill(s.followUpEvent.assigned, '', followUpText(e.toAt, e.toNote))
        : e.kind === 'CHANGED'
          ? fill(s.followUpEvent.changed, followUpText(e.fromAt, e.fromNote), followUpText(e.toAt, e.toNote))
          : e.kind === 'COMPLETED'
            ? s.followUpEvent.completed
            : e.kind === 'CLEARED'
              ? s.followUpEvent.cleared
              : fill(s.followUpEvent.handedOff, e.fromName ?? someone, e.toName ?? someone);
    const detail =
      e.kind === 'HANDED_OFF'
        ? e.fromAt || e.fromNote
          ? fill(s.followUpEvent.handedOffFollowUpFrom, followUpText(e.fromAt, e.fromNote), followUpText(e.toAt, e.toNote))
          : fill(s.followUpEvent.handedOffFollowUp, '', followUpText(e.toAt, e.toNote))
        : e.kind === 'COMPLETED' || e.kind === 'CLEARED'
          ? e.fromAt || e.fromNote
            ? followUpText(e.fromAt, e.fromNote)
            : null
          : null;
    return { id: e.id, source: 'followUp', at: e.createdAt.toISOString(), headline, detail, by: e.actorName ?? someone };
  };
  const systemEvents: LeadSystemEvent[] = followUpEvents.map(followUpLine);
  for (const m of stageMoves) {
    systemEvents.push({
      id: m.id,
      source: 'stage',
      at: m.createdAt.toISOString(),
      headline: s.followUpEvent.stageMoved
        .replace('{from}', () => stageLabel(stages, m.fromStatus, locale))
        .replace('{to}', () => stageLabel(stages, m.toStatus, locale)),
      detail: null,
      by: m.changedBy?.fullName ?? t.common.systemActor,
    });
  }
  // Who planned / cancelled each meeting: plain ids on the row, one lookup.
  const meetingPeople = new Map(
    (
      await prisma.user.findMany({
        where: withinTenant({ id: { in: [...new Set(meetings.flatMap((m) => [m.createdById, m.cancelledById ?? '']).filter(Boolean))] } }, tenant),
        select: { id: true, fullName: true },
      })
    ).map((u) => [u.id, u.fullName]),
  );
  const meetingWhen = (at: Date | null) =>
    at ? formatInTimeZone(at, viewer?.timezone, undefined, intlLocaleFor(locale)) : null;
  for (const m of meetings) {
    const when = meetingWhen(m.scheduledAt);
    // The title is the owner's wording: on a colleague's record only the time.
    const detail = ownersView ? m.title : null;
    systemEvents.push({
      id: `meeting-${m.id}`,
      source: 'meeting',
      at: m.createdAt.toISOString(),
      headline: when ? s.followUpEvent.meetingPlanned.replace('{when}', () => when) : s.followUpEvent.meetingPlannedNoTime,
      detail,
      by: meetingPeople.get(m.createdById) ?? t.common.systemActor,
    });
    if (m.status === 'CANCELLED' && m.cancelledAt) {
      systemEvents.push({
        id: `meeting-cancel-${m.id}`,
        source: 'meeting',
        at: m.cancelledAt.toISOString(),
        headline: when ? s.followUpEvent.meetingCancelled.replace('{when}', () => when) : s.followUpEvent.meetingCancelledNoTime,
        detail,
        by: (m.cancelledById && meetingPeople.get(m.cancelledById)) || t.common.systemActor,
      });
    }
  }
  // Never the `@import.local` stand-in: the account's address, else none.
  const leadEmail = shownEmail(relation.mentee.email, company?.contactEmail);
  // A colleague's record: the contact's name, never their e-mail or phone.
  const contact = {
    name: company?.contactName ?? relation.mentee.fullName,
    email: writable ? company?.contactEmail ?? (leadEmail.toLowerCase().endsWith('@import.local') ? null : leadEmail) : null,
    phone: writable ? company?.contactPhone ?? relation.mentee.phone : null,
    position: company?.contactPosition ?? null,
  };
  // Who may log a contact here (#3748) and move the trial end (status and stage
  // are not part of it: when the record forbids the edit, the panel says why) —
  // the write rule above, which POST /api/interactions and PATCH …/trial apply too.
  const canLog = relation.status === 'ACTIVE' && writable;
  const canEditTrial = writable;
  const canHandOff = writable && relation.status === 'ACTIVE';

  // The partner behind an affiliate-sourced lead (#3647), by this org's own partner list.
  const affiliatePartner = affiliatePartnerNameFor(
    await affiliatePartnerNames([{ orgId: relation.orgId, sourceName: relation.mentee.source?.name }]),
    { orgId: relation.orgId, sourceName: relation.mentee.source?.name },
  );

  return (
    <div data-testid="sales-lead">
      {justSeen && <RefreshRouterCache />}
      <Link href="/sales" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" />
        {s.back}
      </Link>

      {successor && (
        <p
          className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"
          role="status"
          data-testid="sales-lead-handed-on"
        >
          <span>{s.handedOnBanner.replace('{owner}', successor.ownerName).replace('{date}', date(successor.since))}</span>
          {successorOpens && (
            <Link href={`/sales/leads/${successor.relationId}`} className="font-medium underline" data-testid="sales-lead-handed-on-link">
              {s.handedOnOpen}
            </Link>
          )}
        </p>
      )}
      {!writable && !successor && (
        <p
          className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          role="status"
          data-testid="sales-lead-readonly"
        >
          <span>{s.readOnlyBanner.replace('{owner}', relation.mentor.fullName)}</span>
          <Link href={`/messages?to=${relation.mentorId}`} className="font-medium underline" data-testid="sales-lead-message-owner">
            {s.messageOwner}
          </Link>
        </p>
      )}
      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="sales-lead-name">
            {relation.mentee.fullName}
          </h1>
          {earlier[0] && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="sales-lead-taken-over">
              {s.takenOverFrom.replace('{owner}', earlier[0].ownerName).replace('{date}', date(earlier[0].to ?? relation.startDate))}
            </p>
          )}
          {company && (
            <p className="mt-1 text-gray-500">
              <Link href={`/sales/accounts/${company.id}`} className="hover:underline" data-testid="sales-lead-account">
                {company.name}
              </Link>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Hand the record to a colleague from here too (#3657); only an open record moves. */}
          {canHandOff && <LeadPageHandoff relationId={relation.id} leadName={relation.mentee.fullName} />}
          {/* Plan a meeting with this lead (#3778): the calendar's dialog, prefilled; the server decides who may. */}
          {writable && relation.status === 'ACTIVE' && <PlanMeetingButton relationId={relation.id} leadName={relation.mentee.fullName} variant="outline" />}
          <AffiliateSourceBadge partnerName={affiliatePartner} />
          <Badge variant="info" data-testid="sales-lead-stage">{stageLabel(stages, relation.pipelineStatus, locale)}</Badge>
          <Badge variant={relation.status === 'ACTIVE' ? 'success' : 'default'}>
            {relation.status === 'ACTIVE' ? s.statusActive : s.statusCompleted}
          </Badge>
        </div>
      </div>

      <SalesRecordPanels
        relationId={relation.id}
        status={relation.status}
        pipelineStatus={relation.pipelineStatus}
        nextActionAt={ownersView ? iso(relation.nextActionAt) : null}
        // The words alone: the pick reads as its own label, in the reader's language (#3903).
        nextActionNote={ownersView ? handoffNoteText(relation.nextActionNote, locales.map((l) => getDictionary(l).leadHandoff.actions)) || null : null}
        nextActionType={ownersView ? relation.nextActionType : null}
        nextActionTime={ownersView ? relation.nextActionTime : null}
        followUpType={followUpInteractionType(
          relation.nextActionNote,
          locales.map((l) => getDictionary(l).leadHandoff.actions),
          relation.nextActionType,
        )}
        trialStartedAt={iso(relation.trialStartedAt)}
        trialEndsAt={iso(relation.trialEndsAt)}
        contractEndsAt={ownersView ? iso(relation.contractEndsAt) : null}
        canEditTrial={canEditTrial}
        stageName={stageLabel(stages, relation.pipelineStatus, locale)}
        readOnly={!writable}
        showFollowUp={ownersView}
        dealValue={{
          valueMinor: relation.value?.valueMinor ?? null,
          currency: relation.value?.currency ?? null,
          source: relation.value?.source ?? null,
        }}
        interactions={
          <SalesInteractionsCard
            relationId={relation.id}
            canLog={canLog}
            interactions={interactions.map((i) => ({ id: i.id, date: i.date.toISOString(), type: i.type, subject: i.subject, notes: i.notes, outcome: i.outcome }))}
            systemEvents={systemEvents}
            attemptCount={attemptCount}
            earlierPeriods={earlier.map((p, idx) => ({
              relationId: p.relationId,
              ownerName: p.ownerName,
              from: date(p.from),
              to: p.to ? date(p.to) : null,
              interactions: p.interactions.map((i) => ({ id: i.id, date: i.date.toISOString(), type: i.type, subject: i.subject, notes: i.notes, outcome: i.outcome })),
              events: earlierFollowUps[idx].map(followUpLine),
            }))}
          />
        }
        contact={
          <Card padding="sm">
            {/* The person — editable by the record's rep (#3655); the account and the date below are not.
                The phone and e-mail are tel:/mailto: links that also log the contact: the e-mail opens an
                interaction draft (#3741), the phone asks "Did you reach them?" (#3748). */}
            <LeadContactEditor
              relationId={relation.id}
              initial={contact}
              canEdit={!!company && writable}
              logOnContact={canLog}
              companyName={company?.name ?? null}
              senderName={session.user.name ?? null}
              // The call's answer may complete or move the follow-up (#3904): the owner's, like the panel.
              followUp={
                ownersView && writable
                  ? {
                      open: !!(relation.nextActionAt || relation.nextActionNote),
                      isCall:
                        (isHandoffAction(relation.nextActionType)
                          ? relation.nextActionType
                          : handoffActionFromNote(relation.nextActionNote, locales.map((l) => getDictionary(l).leadHandoff.actions))) === 'call',
                    }
                  : null
              }
              title={<CardTitle className="text-base">{s.contact}</CardTitle>}
            />
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-gray-100 pt-3 dark:border-gray-800" data-testid="sales-lead-contact">
              <Field label={s.owner} value={relation.mentor.fullName} testId="sales-lead-owner" />
              <Field label={s.company} value={company?.name} />
              <Field label={s.lastContact} value={lastContact ? date(lastContact) : null} testId="sales-lead-last-contact" />
              <Field label={s.since} value={date(relation.startDate)} hint={s.sinceHint} testId="sales-lead-since" />
            </dl>
            <p className="mt-3 text-sm">
              <Link href="/sales/board" className="text-blue-600 hover:underline">{s.openBoard}</Link>
            </p>
          </Card>
        }
      />

    </div>
  );
}
