import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { SalesRecordPanels } from '@/components/sales/SalesRecordPanels';
import { SalesLogInteraction } from '@/components/sales/SalesLogInteraction';
import { LeadContactEditor } from '@/components/sales/LeadContactEditor';
import { shownEmail } from '@/lib/leadEmail';
import { LeadPageHandoff } from '@/components/sales/LeadPageHandoff';
import { contentLang } from '@/lib/contentLanguage';

// One of the rep's own records (#2580): who the lead is, the account behind it,
// its stage, the follow-up, trial-end and estimated-value (#2422) editors, what happened last and a
// form to log the next call or meeting. The follow-up (what comes next) and the
// last interaction (what happened last) sit together at the top (#3653).
//
// Found only as `id AND mentorId = self AND the rep's tenant` — someone else's
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
  const relation = await prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id, mentorId: session.user.id }, tenant),
    select: {
      id: true,
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
      // Through the tenant filter too: a record pointing at another tenant's
      // company (a bad import) shows no account rather than a foreign one.
      companyId: true,
    },
  });
  if (!relation) notFound();

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
  const last = interactions[0] ?? null;

  // The newest interaction, right under the follow-up (#3653); the full list stays below.
  const lastInteraction = (
    // Same frame as the follow-up panel above it, so the two read as one block.
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="sales-lead-last-interaction">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
          <MessageSquare className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden="true" />
          {s.lastInteraction}
        </p>
        {interactions.length > 0 && (
          <a href="#sales-lead-interactions-card" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
            {s.allInteractions}
          </a>
        )}
      </div>
      {last ? (
        <div className="mt-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <InteractionTypeBadge type={last.type} />
            <span className="text-gray-500">{date(last.date)}</span>
          </div>
          {last.subject && <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{last.subject}</p>}
          <p lang={contentLang(last.notes)} className="mt-0.5 line-clamp-3 text-gray-600 dark:text-gray-300">{last.notes}</p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-gray-500" data-testid="sales-lead-last-interaction-empty">{s.lastInteractionEmpty}</p>
      )}
    </div>
  );

  return (
    <div data-testid="sales-lead">
      <Link href="/sales" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" />
        {s.back}
      </Link>

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
          {relation.status === 'ACTIVE' && <LeadPageHandoff relationId={relation.id} leadName={relation.mentee.fullName} />}
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
        dealValue={{
          valueMinor: relation.value?.valueMinor ?? null,
          currency: relation.value?.currency ?? null,
          source: relation.value?.source ?? null,
        }}
        lastInteraction={lastInteraction}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{s.contact}</CardTitle>
          </CardHeader>
          {/* The person — editable by the record's rep (#3655); the account and the date below are not. */}
          <LeadContactEditor relationId={relation.id} initial={contact} canEdit={!!company} />
          <dl className="mt-4 grid grid-cols-1 gap-4 border-t border-gray-100 pt-4 dark:border-gray-800" data-testid="sales-lead-contact">
            <Field label={s.company} value={company?.name} />
            <Field label={s.since} value={date(relation.startDate)} hint={s.sinceHint} testId="sales-lead-since" />
          </dl>
          <p className="mt-4 text-sm">
            <Link href="/sales/board" className="text-blue-600 hover:underline">{s.openBoard}</Link>
          </p>
        </Card>

        <Card id="sales-lead-interactions-card" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>{s.interactions}</CardTitle>
            <p className="text-sm text-gray-600 dark:text-gray-400">{s.interactionsHint}</p>
          </CardHeader>
          {relation.status === 'ACTIVE' && (
            <div className="mb-3">
              <SalesLogInteraction relationId={relation.id} />
            </div>
          )}
          {interactions.length === 0 ? (
            <p className="text-sm text-gray-500">{s.interactionsEmpty}</p>
          ) : (
            <ul className="space-y-3" data-testid="sales-lead-interactions">
              {interactions.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <InteractionTypeBadge type={i.type} />
                    <span className="text-gray-500">{date(i.date)}</span>
                  </div>
                  {i.subject && <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{i.subject}</p>}
                  <p lang={contentLang(i.notes)} className="mt-0.5 line-clamp-2 text-gray-600">{i.notes}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
