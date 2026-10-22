'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';

// The programme's partners (docs/affiliate-module.md, #3116): list with totals,
// add a partner, suspend / reactivate / terminate, and reveal the payout IBAN for
// the transfer (audited). Every rule is the server's; this page only asks.
// A termination is a calendar date, stored as UTC midnight and shown in UTC.

type Status = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
interface Row {
  id: string;
  code: string;
  displayName: string;
  contactEmail: string | null;
  status: Status;
  noticeEffectiveAt: string | null;
  hasAccount: boolean;
  customers: number;
  totals: { PENDING: number; APPROVED: number; PAID: number };
  payoutIban: string | null;
}

const STATUS_VARIANT: Record<Status, 'success' | 'warning' | 'default'> = { ACTIVE: 'success', SUSPENDED: 'warning', TERMINATED: 'default' };

export default function AffiliatePartnersPage() {
  const t = useT();
  const L = t.affiliatePartners;
  const locale = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState({ code: '', displayName: '', contactEmail: '' });
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [terminating, setTerminating] = useState<{ id: string; date: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, { iban: string; holder: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/affiliate/partners');
    if (!res.ok) {
      setFailed(true);
      return;
    }
    const body = await res.json();
    setRows(body.partners);
    setCanWrite(Boolean(body.canWrite));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number) => formatMinorAmount(minor, 'EUR', locale);

  async function add() {
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/admin/affiliate/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.added);
        setForm({ code: '', displayName: '', contactEmail: '' });
        await load();
      } else if (body.code === 'code_taken') {
        setIssues(new Set(['code']));
        toast(L.codeTaken, 'error');
      } else if (body.code === 'invalid_input') {
        setIssues(new Set(body.issues));
        toast(L.invalid, 'error');
      } else toast(L.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setState(id: string, status: Status, noticeEffectiveAt: string | null = null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/affiliate/partners/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, noticeEffectiveAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.saved);
        if (body.drift > 0) toast(interpolate(L.drift, { n: String(body.drift) }), 'error');
        setTerminating(null);
        await load();
      } else toast(L.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reveal(id: string) {
    const res = await fetch(`/api/admin/affiliate/partners/${id}/payout-details`);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.details) setRevealed({ ...revealed, [id]: body.details });
    else toast(L.failed, 'error');
  }

  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />
      {rows && !canWrite && <p className="text-sm text-gray-600 dark:text-gray-400">{L.readOnly}</p>}

      {!rows ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState testId="affiliate-partners" title={L.empty} />
      ) : (
        <div className="space-y-3" data-testid="affiliate-partner-list">
          {rows.map((p) => (
            <Card key={p.id} data-testid={`affiliate-partner-${p.code}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-semibold text-gray-900 dark:text-gray-100">
                    {p.displayName} <span className="font-mono text-sm text-gray-500">{`?ref=${p.code}`}</span>
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {p.contactEmail ?? '—'} · {L.account}: {p.hasAccount ? L.hasAccount : L.noAccount} · {L.customers}: {p.customers}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {L.pending}: {money(p.totals.PENDING)} · {L.approved}: {money(p.totals.APPROVED)} · {L.paid}: {money(p.totals.PAID)}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {L.payout}:{' '}
                    {revealed[p.id] ? (
                      <span className="font-mono" data-testid={`affiliate-iban-${p.code}`}>
                        {revealed[p.id].iban} · {revealed[p.id].holder}
                      </span>
                    ) : (
                      <>
                        {p.payoutIban ?? L.payoutNone}
                        {p.payoutIban && canWrite && (
                          <Button type="button" size="sm" variant="ghost" title={L.revealHint} onClick={() => void reveal(p.id)}>
                            {L.reveal}
                          </Button>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge variant={STATUS_VARIANT[p.status]}>{L[`status${p.status}`]}</Badge>
                  {p.noticeEffectiveAt && <span className="text-xs text-gray-500">{interpolate(L.noticeFrom, { date: formatDate(p.noticeEffectiveAt, locale, { timeZone: 'UTC' }) })}</span>}
                  {canWrite && (
                    <div className="flex flex-wrap justify-end gap-2">
                      {p.status === 'ACTIVE' && (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void setState(p.id, 'SUSPENDED')}>
                          {L.suspend}
                        </Button>
                      )}
                      {p.status !== 'ACTIVE' && (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void setState(p.id, 'ACTIVE')}>
                          {L.reactivate}
                        </Button>
                      )}
                      {p.status !== 'TERMINATED' && (
                        <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => setTerminating({ id: p.id, date: '' })}>
                          {L.terminate}
                        </Button>
                      )}
                    </div>
                  )}
                  {terminating?.id === p.id && (
                    <div className="flex flex-wrap items-end gap-2">
                      <Input type="date" label={L.terminateDate} value={terminating.date} onChange={(e) => setTerminating({ id: p.id, date: e.target.value })} />
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={busy || !terminating.date}
                        onClick={() => void setState(p.id, 'TERMINATED', new Date(`${terminating.date}T00:00:00Z`).toISOString())}
                      >
                        {L.confirmTerminate}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setTerminating(null)}>
                        {L.cancel}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{L.add}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input label={L.code} hint={L.codeHint} value={form.code} error={issues.has('code') ? L.invalid : undefined} onChange={(e) => setForm({ ...form, code: e.target.value })} data-testid="affiliate-new-code" />
            <Input label={L.displayName} value={form.displayName} error={issues.has('displayName') ? L.invalid : undefined} onChange={(e) => setForm({ ...form, displayName: e.target.value })} data-testid="affiliate-new-name" />
            <Input label={L.contactEmail} hint={L.contactEmailHint} type="email" value={form.contactEmail} error={issues.has('contactEmail') ? L.invalid : undefined} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} data-testid="affiliate-new-email" />
          </div>
          <div className="mt-3">
            <Button type="button" disabled={busy} onClick={() => void add()} data-testid="affiliate-add-partner">
              {L.add}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
