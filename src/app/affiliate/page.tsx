'use client';

// The partner's own page: their referral link, what they have earned and what is
// still open, the commissions, and the bank details the admin pays into.
// Every number comes from /api/affiliate/me, which only ever returns this partner's rows.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { RelativeTime } from '@/components/ui/RelativeTime';

interface Commission {
  id: string;
  kind: 'TIER' | 'PERCENT';
  amountMinor: number;
  currency: string;
  status: string;
  accruedAt: string;
  paidAt: string | null;
}

interface Summary {
  code: string;
  status: string;
  totals: { paidMinor: number; openMinor: number; currency: string };
  commissions: Commission[];
  payout: { accountHolder: string; ibanLast4: string } | null;
}

const eur = (minor: number) => `€${(minor / 100).toFixed(2)}`;


export default function AffiliatePortalPage() {
  const t = useT();
  const a = t.affiliates;
  const statusLabel = (status: string) =>
    ({ PENDING: a.statusPending, APPROVED: a.statusApproved, PAID: a.statusPaid, REJECTED: a.statusRejected } as Record<string, string>)[status] ?? status;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/affiliate/me');
    if (res.status === 404) {
      setMissing(true);
      return;
    }
    if (!res.ok) {
      setMessage(`${a.msgLoadFailed} (${res.status}).`);
      return;
    }
    setSummary(await res.json());
  }, [a.msgLoadFailed]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveDetails(form: HTMLFormElement) {
    const fd = new FormData(form);
    const res = await fetch('/api/affiliate/me/payout-details', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountHolder: String(fd.get('accountHolder')),
        iban: String(fd.get('iban')),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(`${a.msgBankNotSaved}: ${data.error ?? res.status}`);
      return;
    }
    setMessage(a.msgBankSaved);
    form.reset();
    await load();
  }

  if (missing) return <p className="text-sm">{a.noPartner}</p>;
  if (!summary) return <p className="text-sm">{message ?? '…'}</p>;

  const link = `${window.location.origin}/?ref=${summary.code}`;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{a.title}</h1>
      {message && <p role="status" className="text-sm">{message}</p>}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{a.yourLink}</h2>
        <p className="break-all font-mono text-sm">{link}</p>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="rounded border p-4">
          <p className="text-sm">{a.paidTotal}</p>
          <p className="text-xl font-semibold">{eur(summary.totals.paidMinor)}</p>
        </div>
        <div className="rounded border p-4">
          <p className="text-sm">{a.openTotal}</p>
          <p className="text-xl font-semibold">{eur(summary.totals.openMinor)}</p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{a.yourCommissions}</h2>
        {summary.commissions.length === 0 ? (
          <p className="text-sm">{a.nothingToPay}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">{a.colReceived}</th>
                <th className="p-2">{a.colCommission}</th>
                <th className="p-2">{a.colAmount}</th>
                <th className="p-2">{a.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {summary.commissions.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="p-2"><RelativeTime date={c.accruedAt} /></td>
                  <td className="p-2">{c.kind === 'TIER' ? a.kindTier : a.kindPercent}</td>
                  <td className="p-2">{eur(c.amountMinor)}</td>
                  <td className="p-2">{statusLabel(c.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{a.bankTitle}</h2>
        {summary.payout && (
          <p className="text-sm">
            {summary.payout.accountHolder} · {a.ibanEnding} {summary.payout.ibanLast4}
          </p>
        )}
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveDetails(e.currentTarget);
          }}
        >
          <input name="accountHolder" required aria-label={a.accountHolder} placeholder={a.accountHolder} className="rounded border p-2" />
          <input name="iban" required aria-label={a.iban} placeholder={a.iban} className="rounded border p-2" />
          <button type="submit" className="rounded border px-4 py-2 md:w-fit">{a.saveBank}</button>
        </form>
      </section>
    </div>
  );
}
