import Link from 'next/link';
import { AffiliateSourceBadge } from '@/components/AffiliateSourceBadge';
import { affiliatePartnerNames, affiliatePartnerNameFor } from '@/lib/affiliateLeadSource';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
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
import { Card, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SalesRecordPanels } from '@/components/sales/SalesRecordPanels';
import { PlanMeetingButton } from '@/app/sales/calendar/PlanMeetingDialog';
import { SalesInteractionsCard } from '@/components/sales/SalesInteractionsCard';
import { LeadContactEditor } from '@/components/sales/LeadContactEditor';
import { shownEmail } from '@/lib/leadEmail';
import { LeadPageHandoff } from '@/components/sales/LeadPageHandoff';

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
    },
  });
  if (!relation) notFound();
  // Who may WORK this record — every editor below, the hand-off (#3657), the
  // contact log (#3748), the trial end: the rule the write routes apply.
  const writable = await canWriteSalesRecord(session, relation);
  const ownersView = writable || canSeeNextAction({ id: session.user.id, role: session.user.role }, relation);

  const [company, lastContact, interactions] = await Promise.all([
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
      select: { id: true, date: true, type: true, subject: true, notes: true },
    }),
  ]);

  const { locale, t } = await getServerDictionary();
  const s = t.sales.lead;
  const stages = await resolvePipelineStages(session.user.orgId, locale);
  const date = (value: Date) => formatDate(value, locale);
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
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
      <Link href="/sales" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" />
        {s.back}
      </Link>

      {!writable && (
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
        nextActionNote={ownersView ? relation.nextActionNote : null}
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
            interactions={interactions.map((i) => ({ id: i.id, date: i.date.toISOString(), type: i.type, subject: i.subject, notes: i.notes }))}
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
