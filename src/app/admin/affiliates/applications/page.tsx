'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { interpolate } from '@/lib/notificationText';
import { APPLICATION_REJECTION_CODES, type ApplicationRejectionCode, type AffiliateHeardFrom } from '@/lib/affiliateApplicationRule';
import { AffiliateTabs, APPLICATIONS_CHANGED } from '../AffiliateTabs';

// Partner applications from the public form (docs/affiliate-module.md, #3362):
// the pending ones first, approve with a referral code (creates the partner and
// sends the ordinary invitation) or decline with a reason code. Every rule is
// the server's; this page only asks.

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';
interface Row {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string | null;
  phone: string | null;
  heardFrom: AffiliateHeardFrom;
  heardFromOther: string | null;
  status: Status;
  decisionCode: ApplicationRejectionCode | null;
  createdAt: string;
  suggestedCode: string | null;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'success' | 'default'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'default' };

export default function AffiliateApplicationsPage() {
  const t = useT();
  const L = t.affiliateApplications;
  const toast = useToast();
  const [filter, setFilter] = useState<Status | ''>('PENDING');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<{ id: string; reason: ApplicationRejectionCode; note: string } | null>(null);
  // The register link of an approval whose invitation mail could not be sent, to pass on
  // by hand. Kept above the list: the approved row leaves the "waiting" filter.
  const [inviteLink, setInviteLink] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/affiliate/applications${filter ? `?status=${filter}` : ''}`);
    if (res.status === 403) return setForbidden(true);
    if (!res.ok) return setFailed(true);
    const body = (await res.json()) as { applications: Row[]; canWrite: boolean };
    setRows(body.applications);
    setCanWrite(body.canWrite);
    setCodes(Object.fromEntries(body.applications.filter((r) => r.suggestedCode).map((r) => [r.id, r.suggestedCode as string])));
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/affiliate/applications/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codes[id] ?? '' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (body.inviteError) toast(interpolate(L.approvedNoInvite, { reason: t.affiliatePartners.inviteErrors[body.inviteError as keyof typeof t.affiliatePartners.inviteErrors] ?? body.inviteError }), 'error');
        else if (body.invitation && !body.invitation.emailSent && body.invitation.registerUrl) {
          const row = rows?.find((r) => r.id === id);
          setInviteLink({ name: row ? `${row.firstName} ${row.lastName}` : '', url: body.invitation.registerUrl });
          toast(L.approvedMailFailed, 'error');
        } else toast(L.approved);
        window.dispatchEvent(new Event(APPLICATIONS_CHANGED));
        await load();
      } else toast(L.errors[body.code as keyof typeof L.errors] ?? t.affiliateSettings.loadFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/affiliate/applications/${rejecting.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejecting.reason, note: rejecting.note }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.rejected);
        setRejecting(null);
        window.dispatchEvent(new Event(APPLICATIONS_CHANGED));
        await load();
      } else toast(L.errors[body.code as keyof typeof L.errors] ?? t.affiliateSettings.loadFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
      <AffiliateTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-600 dark:text-gray-400">{L.hint}</p>
        <div className="w-full sm:w-56">
        <Select
          label={L.filter}
          value={filter}
          onChange={(e) => setFilter(e.target.value as Status | '')}
          options={[
            { value: 'PENDING', label: L.status.PENDING },
            { value: 'APPROVED', label: L.status.APPROVED },
            { value: 'REJECTED', label: L.status.REJECTED },
            { value: '', label: L.all },
          ]}
          data-testid="affiliate-applications-filter"
        />
        </div>
      </div>

      {inviteLink && (
        <p className="break-all rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:text-amber-100" role="status" data-testid="affiliate-application-invite-link">
          {inviteLink.name && <strong>{inviteLink.name}: </strong>}
          {t.affiliatePartners.inviteLink} <span className="font-mono">{inviteLink.url}</span>
        </p>
      )}

      {failed ? (
        <p className="text-sm text-red-600" role="alert">{t.affiliateSettings.loadFailed}</p>
      ) : !rows ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState testId="affiliate-applications-empty" title={L.emptyTitle} body={L.emptyBody} />
      ) : (
        <ul className="space-y-3" data-testid="affiliate-applications-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Card data-testid={`affiliate-application-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold text-gray-900 dark:text-gray-100">
                      {r.firstName} {r.lastName}
                      {r.company && <span className="font-normal text-gray-600 dark:text-gray-400"> · {r.company}</span>}
                    </p>
                    <p className="break-all text-sm text-gray-700 dark:text-gray-300">
                      {r.email}
                      {r.phone && <> · {r.phone}</>}
                    </p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {L.heardFrom}: {t.affiliateApply.heardFromOptions[r.heardFrom]}
                      {r.heardFromOther && <> — {r.heardFromOther}</>}
                    </p>
                    <p className="text-xs text-gray-500">
                      <RelativeTime date={r.createdAt} />
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge variant={STATUS_VARIANT[r.status]}>{L.status[r.status]}</Badge>
                    {r.decisionCode && <p className="mt-1 text-xs text-gray-500">{L.reasons[r.decisionCode]}</p>}
                  </div>
                </div>

                {r.status === 'PENDING' && canWrite && (
                  <div className="mt-4 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
                    {rejecting?.id === r.id ? (
                      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto_auto] sm:items-end">
                        <Select
                          label={L.reason}
                          value={rejecting.reason}
                          onChange={(e) => setRejecting({ ...rejecting, reason: e.target.value as ApplicationRejectionCode })}
                          options={APPLICATION_REJECTION_CODES.map((c) => ({ value: c, label: L.reasons[c] }))}
                          data-testid="affiliate-application-reason"
                        />
                        <Input label={L.note} hint={L.noteHint} maxLength={500} value={rejecting.note} onChange={(e) => setRejecting({ ...rejecting, note: e.target.value })} />
                        <Button type="button" variant="danger" disabled={busy} onClick={() => void reject()} data-testid="affiliate-application-confirm-reject">
                          {L.confirmReject}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setRejecting(null)}>
                          {L.cancel}
                        </Button>
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                        <Input
                          label={L.code}
                          hint={L.codeHint}
                          value={codes[r.id] ?? ''}
                          onChange={(e) => setCodes({ ...codes, [r.id]: e.target.value })}
                          data-testid="affiliate-application-code"
                        />
                        <Button type="button" disabled={busy} onClick={() => void approve(r.id)} data-testid="affiliate-application-approve">
                          {L.approve}
                        </Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => setRejecting({ id: r.id, reason: 'not_a_fit', note: '' })} data-testid="affiliate-application-reject">
                          {L.reject}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
