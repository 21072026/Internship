import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { stageLabel, type ResolvedStage } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import type { CompanyDetailData } from '@/lib/companyDetail';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { CompanyExternalIdForm } from '@/components/admin/CompanyExternalIdForm';
import { ContactPermissionEditor } from '@/components/admin/ContactPermissionEditor';
import { CONTACT_CHANNELS, marketingEmailAllowed } from '@/lib/contactPermissionRule';

// The account detail screen (#2560), rendered by the ADMIN page and — without
// any of its editors — by the sales rep's own view (/sales/accounts/[id], #2580).
// What the rows ARE is decided by the loader (src/lib/companyDetail.ts); this
// file only draws them. The column rule stays in src/lib/companyVisibility.ts:
// a non-ADMIN reader never gets the ADMIN-only fields, whoever renders this.

type Relation = CompanyDetailData['company']['mentorships'][number];

function Field({ label, value, testId }: { label: string; value?: string | number | null; testId?: string }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100 break-words">{value}</dd>
    </div>
  );
}

export function CompanyDetailView({
  data,
  role,
  t,
  locale,
  stages,
  backHref,
  backLabel,
  personHref,
  showAdminEditors,
}: {
  data: CompanyDetailData;
  role: string;
  t: Dictionary;
  locale: Locale;
  stages: ResolvedStage[];
  backHref: string;
  backLabel: string;
  personHref: (relation: Relation) => string;
  /** The external-id editor writes through an ADMIN-only route. */
  showAdminEditors: boolean;
}) {
  const d = t.companyDetail;
  const company = redactCompanyForReader(data.company, role) as typeof data.company;
  const { interactions } = data;
  const date = (value: Date) => formatDate(value, locale);
  const p = d.permission;
  const permissionFor = (channel: string) => company.contactPermissions.find((row) => row.channel === channel) ?? null;
  // The same gate a marketing send asks (src/lib/contactPermissionRule.ts),
  // against the address on file NOW: a confirmation is for the address that
  // confirmed, not for whoever the contact is today.
  const emailPermitted = company.contactEmail
    ? marketingEmailAllowed(permissionFor('EMAIL'), company.contactEmail)
    : false;

  return (
    <div data-testid="company-detail">
      <Link
        href={backHref}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="company-detail-name">
            {company.name}
          </h1>
          {company.industry && <p className="mt-1 text-gray-500">{company.industry}</p>}
        </div>
        {company.externalId && (
          <Badge variant="default" data-testid="company-detail-external-id">
            <span className="font-mono">{company.externalId}</span>
          </Badge>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{d.sections.account}</CardTitle>
          </CardHeader>
          <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={d.fields.industry} value={company.industry} />
            <Field label={d.fields.size} value={company.size} />
            <Field label={d.fields.country} value={company.country} />
            <Field label={d.fields.address} value={company.address} />
            <Field label={d.fields.vatId} value={company.vatId} testId="company-detail-vat-id" />
            <Field label={d.fields.quota} value={company.quota} />
            <Field label={d.fields.createdAt} value={date(company.createdAt)} />
          </dl>
          {company.description && (
            <div className="mb-6" data-testid="company-detail-description">
              <p className="text-xs text-gray-500">{d.fields.description}</p>
              <p className="whitespace-pre-line text-sm text-gray-600">{company.description}</p>
            </div>
          )}
          {showAdminEditors && (
            <CompanyExternalIdForm companyId={company.id} initial={company.externalId} labels={d.externalId} />
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{d.sections.contact}</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-4" data-testid="company-detail-contact">
            <Field label={d.fields.contactName} value={company.contactName} testId="company-detail-contact-name" />
            <Field label={d.fields.contactEmail} value={company.contactEmail} />
            {company.contactEmail && (
              <p
                data-testid="company-detail-email-permission"
                data-permitted={emailPermitted ? 'true' : 'false'}
                className={
                  emailPermitted
                    ? 'rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800'
                    : 'rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800'
                }
              >
                {emailPermitted ? p.emailAllowed : p.emailWarning}
              </p>
            )}
            <Field label={d.fields.contactPhone} value={company.contactPhone} testId="company-detail-contact-phone" />
          </dl>
          {!company.contactName && !company.contactEmail && !company.contactPhone && (
            <p className="text-sm text-gray-500">{d.notSet}</p>
          )}
        </Card>
      </div>

      {/* Contact permission and its evidence (#2577, docs/contact-permission.md). */}
      <Card className="mb-6" data-testid="company-detail-permission">
        <CardHeader>
          <CardTitle>{p.title}</CardTitle>
        </CardHeader>
        <p className="mb-4 text-sm text-gray-500">{p.intro}</p>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CONTACT_CHANNELS.map((channel) => {
            const row = permissionFor(channel);
            return (
              <div key={channel} data-testid={`company-detail-permission-${channel}`}>
                <dt className="text-xs text-gray-500">{p.channels[channel]}</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">
                  {!row ? (
                    <span className="text-gray-500">{p.notRecorded}</span>
                  ) : (
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={row.revokedAt ? 'danger' : row.basis === 'NONE' || row.basis === 'INQUIRY_REPLY' ? 'default' : 'success'}
                          data-testid={`company-detail-permission-basis-${channel}`}
                          data-basis={row.basis}
                          data-revoked={row.revokedAt ? 'true' : 'false'}
                        >
                          {p.bases[row.basis]}
                        </Badge>
                        {row.revokedAt && (
                          <span className="text-xs text-red-700">{p.revoked.replace('{date}', date(row.revokedAt))}</span>
                        )}
                      </span>
                      <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
                        {row.address && <li>{p.address.replace('{address}', row.address)}</li>}
                        {row.requestedAt && <li>{p.requested.replace('{date}', date(row.requestedAt))}</li>}
                        {row.confirmedAt && <li>{p.confirmed.replace('{date}', date(row.confirmedAt))}</li>}
                        {row.textVersion && (
                          <li>{p.textVersion.replace('{version}', row.textVersion).replace('{locale}', row.textLocale ?? '—')}</li>
                        )}
                        <li>{p.source.replace('{source}', p.sources[row.source])}</li>
                        {role === 'ADMIN' && row.reason && <li>{p.reason.replace('{reason}', row.reason)}</li>}
                      </ul>
                    </>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {showAdminEditors && (
          <ContactPermissionEditor
            companyId={company.id}
            labels={{ ...p.editor, channels: p.channels, bases: p.bases }}
          />
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{d.sections.funnel}</CardTitle>
        </CardHeader>
        {company.mentorships.length === 0 ? (
          <p className="text-sm text-gray-500">{d.funnel.empty}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} aria-label={d.sections.funnel} role="region">
            <table className="w-full text-left text-sm" data-testid="company-detail-relations">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.person}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.stage}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.owner}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.status}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.trial}</th>
                  <th scope="col" className="py-2 font-medium">{d.funnel.nextAction}</th>
                </tr>
              </thead>
              <tbody>
                {company.mentorships.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-gray-100 align-top last:border-0"
                    data-testid={`company-detail-relation-${r.id}`}
                  >
                    <td className="py-2 pr-4">
                      <Link href={personHref(r)} className="font-medium text-blue-600 hover:underline">
                        {r.mentee.fullName}
                      </Link>
                      {r.earlierMentors.length > 0 && (
                        <p className="mt-0.5 text-xs text-gray-500" data-testid={`company-detail-relation-chain-${r.id}`}>
                          {d.funnel.continues.replace('{name}', r.earlierMentors.join(', '))}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-4" data-testid={`company-detail-relation-stage-${r.id}`}>
                      {stageLabel(stages, r.pipelineStatus, locale)}
                    </td>
                    <td className="py-2 pr-4">{r.mentor.fullName}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={r.status === 'ACTIVE' ? 'success' : 'default'}>
                        {r.status === 'ACTIVE' ? d.funnel.statusActive : d.funnel.statusCompleted}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {r.trialStartedAt && r.trialEndsAt
                        ? d.funnel.trialWindow
                            .replace('{start}', date(r.trialStartedAt))
                            .replace('{end}', date(r.trialEndsAt))
                        : r.trialEndsAt
                          ? d.funnel.trialEnds.replace('{date}', date(r.trialEndsAt))
                          : d.notSet}
                    </td>
                    <td className="py-2" data-testid={`company-detail-relation-next-${r.id}`}>
                      {r.nextActionAt || r.nextActionNote ? (
                        <>
                          {r.nextActionAt && <span className="whitespace-nowrap">{date(r.nextActionAt)}</span>}
                          {r.nextActionNote && <p className="text-xs text-gray-600">{r.nextActionNote}</p>}
                        </>
                      ) : (
                        d.notSet
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{d.sections.interactions}</CardTitle>
          </CardHeader>
          {interactions.length === 0 ? (
            <p className="text-sm text-gray-500">{d.interactionsEmpty}</p>
          ) : (
            <ul className="space-y-3" data-testid="company-detail-interactions">
              {interactions.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <InteractionTypeBadge type={i.type} />
                    <span className="text-gray-500">{date(i.date)}</span>
                    <span className="text-gray-700">
                      {d.interactionWith.replace('{name}', i.relation.mentee.fullName)}
                    </span>
                  </div>
                  {i.subject && <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{i.subject}</p>}
                  <p className="mt-0.5 line-clamp-2 text-gray-600">{i.notes}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{d.sections.needs}</CardTitle>
          </CardHeader>
          {company.needs.length === 0 ? (
            <p className="text-sm text-gray-500">{d.needsEmpty}</p>
          ) : (
            <ul className="space-y-1.5">
              {company.needs.map((need) => (
                <li
                  key={need.id}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-gray-700">{need.position}</span>
                  <span className="text-gray-500">
                    {need.count} × {need.period}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
