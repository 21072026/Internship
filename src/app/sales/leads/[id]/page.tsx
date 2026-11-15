import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { isSalesDispatcher } from '@/lib/salesDispatcher';
import { salesBookReadWhere } from '@/lib/salesBookRule';
import { canWriteSalesRecord } from '@/lib/salesBook';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SalesRecordPanels } from '@/components/sales/SalesRecordPanels';
import { SalesInteractionsCard } from '@/components/sales/SalesInteractionsCard';
import { LeadContactEditor } from '@/components/sales/LeadContactEditor';
import { shownEmail } from '@/lib/leadEmail';
import { LeadPageHandoff } from '@/components/sales/LeadPageHandoff';

// One of the rep's own records (#2580): who the lead is, the account behind it,
// its stage, the follow-up, trial-end and estimated-value (#2422) editors, what happened last and a
// form to log the next call or meeting. The follow-up (what comes next) and the
// interactions (what already happened) sit side by side at the top (#3737).
//
// Found only as `id AND mentorId = self AND the rep's tenant` (any owner for a
// sales dispatcher, #3656, still inside the tenant) — someone else's
// record, another tenant's, or an id that does not exist are the same 404 (no
// loading.tsx above this page, so notFound() is the status line too). The
// editors write through routes that re-check ownership themselves.
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
  const dispatcher = await isSalesDispatcher(session.user.id);
  const relation = await prisma.mentorshipRelation.findFirst({
    // The team view (src/lib/salesBookRule.ts): every seller opens every sales
    // record of the org — the tenant filter keeps it inside the org. Whether the
    // viewer may WORK it is the write rule below; a colleague's record opens
    // read-only, never as a 404 (every card the team board shows opens here).
    where: withinTenant({ id, ...salesBookReadWhere({ userId: session.user.id, dispatcher }, 'team') }, tenant),
    select: {
      id: true,
      orgId: true,
      mentorId: true,
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
      mentee: { select: { id: true, fullName: true, email: true, phone: true } },
      mentor: { select: { fullName: true } },
      // Through the tenant filter too: a record pointing at another tenant's
      // company (a bad import) shows no account rather than a foreign one.
      companyId: true,
    },
  });
  if (!relation) notFound();
  // Who may WORK this record (src/lib/salesBookRule.ts, salesBookWriteAllowed):
  // the owner, the org's sales dispatcher, or an admin with relation.write.
  // Anyone else reads it — every editor below is off, and every write route
  // refuses them on its own anyway.
  const writable = await canWriteSalesRecord(session, relation);
  // The hand-off button (#3657): the same rule, on an open record.
  const canHandOff = writable && relation.status === 'ACTIVE';


  const [company, interactions] = await Promise.all([
    relation.companyId
      ? prisma.company.findFirst({
          where: withinTenant({ id: relation.companyId }, tenant),
          // The account's primary contact IS the lead's contact (#3655): the lead
          // row carries a stand-in address (src/lib/leadEmail.ts).
          select: { id: true, name: true, industry: true, contactName: true, contactEmail: true, contactPhone: true, contactPosition: true },
        })
      : null,
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
  const contact = {
    name: company?.contactName ?? relation.mentee.fullName,
    email: company?.contactEmail ?? (leadEmail.toLowerCase().endsWith('@import.local') ? null : leadEmail),
    phone: company?.contactPhone ?? relation.mentee.phone,
    position: company?.contactPosition ?? null,
  };
  // Who may log a contact here (#3748) and move the trial end — the write rule
  // above, which POST /api/interactions and PATCH …/trial apply too. The phone
  // link's "Did you reach them?" is offered only to them; a reader's phone link
  // is a plain tel: link.
  const canLog = relation.status === 'ACTIVE' && writable;
  const canEditTrial = writable;

  return (
    <div data-testid="sales-lead">
      <Link href="/sales" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" />
        {s.back}
      </Link>

      {!writable && (
        <p
          className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          role="status"
          data-testid="sales-lead-readonly"
        >
          {s.readOnlyBanner.replace('{owner}', relation.mentor.fullName)}
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
        nextActionAt={iso(relation.nextActionAt)}
        nextActionNote={relation.nextActionNote}
        trialStartedAt={iso(relation.trialStartedAt)}
        trialEndsAt={iso(relation.trialEndsAt)}
        contractEndsAt={iso(relation.contractEndsAt)}
        canEditTrial={canEditTrial}
        stageName={stageLabel(stages, relation.pipelineStatus, locale)}
        readOnly={!writable}
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
          <Card>
            <CardHeader>
              <CardTitle>{s.contact}</CardTitle>
            </CardHeader>
            {/* The person — editable by the record's rep (#3655); the account and the date below are not.
                The phone and e-mail are tel:/mailto: links that also log the contact: the e-mail opens an
                interaction draft (#3741), the phone asks "Did you reach them?" (#3748). */}
            <LeadContactEditor relationId={relation.id} initial={contact} canEdit={!!company && writable} logOnContact={canLog} />
            <dl className="mt-4 grid grid-cols-1 gap-4 border-t border-gray-100 pt-4 dark:border-gray-800" data-testid="sales-lead-contact">
              <Field label={s.owner} value={relation.mentor.fullName} testId="sales-lead-owner" />
              <Field label={s.company} value={company?.name} />
              <Field label={s.since} value={date(relation.startDate)} hint={s.sinceHint} testId="sales-lead-since" />
            </dl>
            <p className="mt-4 text-sm">
              <Link href="/sales/board" className="text-blue-600 hover:underline">{s.openBoard}</Link>
            </p>
          </Card>
        }
      />

    </div>
  );
}
