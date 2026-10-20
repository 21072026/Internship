'use client';

// Admin: record the payments referred customers make, pay commissions by hand,
// and see the partner's bank details for the transfer (docs/affiliate-module.md).
//
// Every write goes through the /api/admin/affiliate routes, which call the single
// writer, so the rules here are the same as for any other source of payments.
// Copy comes from the `affiliates` block of src/i18n/dictionaries.ts.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

interface Partner {
  id: string;
  code: string;
  user: { fullName: string };
}

interface PaymentRow {
  id: string;
  amountMinor: number;
  currency: string;
  receivedAt: string;
  externalPaymentRef: string | null;
  source: 'MANUAL' | 'API';
  customer: { externalRef: string; partner: { id: string; code: string } };
  commission: { id: string; kind: 'TIER' | 'PERCENT'; amountMinor: number; status: string } | null;
}

interface PayoutDetails {
  accountHolder: string;
  iban: string;
}

const eur = (minor: number) => `€${(minor / 100).toFixed(2)}`;

export default function AffiliatePaymentsPage() {
  const t = useT();
  const a = t.affiliates;
  const [partners, setPartners] = useState<Partner[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [details, setDetails] = useState<PayoutDetails | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payRef, setPayRef] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/affiliate/payments');
    if (!res.ok) {
      setMessage(`${a.msgLoadFailed} (${res.status}).`);
      return;
    }
    const data = await res.json();
    setPartners(data.partners);
    setPayments(data.payments);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!partnerId) {
      setDetails(null);
      return;
    }
    fetch(`/api/admin/affiliate/partners/${partnerId}/payout-details`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setDetails(data?.details ?? null))
      .catch(() => setDetails(null));
  }, [partnerId]);

  async function recordPayment(form: HTMLFormElement) {
    const fd = new FormData(form);
    const euros = Number(fd.get('amount'));
    const body = {
      partnerId: String(fd.get('partnerId')),
      externalCustomerRef: String(fd.get('externalCustomerRef')),
      amountMinor: Math.round(euros * 100),
      currency: 'EUR',
      receivedAt: new Date(String(fd.get('receivedAt'))).toISOString(),
      externalPaymentRef: String(fd.get('externalPaymentRef')),
    };
    const res = await fetch('/api/admin/affiliate/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok ? a.msgRecorded : `${a.msgNotRecorded}: ${data.error ?? res.status}`);
    if (res.ok) {
      form.reset();
      await load();
    }
  }

  async function saveDetails(form: HTMLFormElement) {
    const fd = new FormData(form);
    const res = await fetch(`/api/admin/affiliate/partners/${partnerId}/payout-details`, {
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
    const reread = await fetch(`/api/admin/affiliate/partners/${partnerId}/payout-details`).then((r) => r.json());
    setDetails(reread.details ?? null);
  }

  const openCommissions = payments.filter((p) => p.commission && p.commission.status !== 'PAID');

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function markPaid() {
    const rows = openCommissions.filter((p) => selected.includes(p.commission!.id));
    if (rows.length === 0) return;
    const partnerIds = [...new Set(rows.map((p) => p.customer.partner.id))];
    if (partnerIds.length !== 1) {
      setMessage(a.msgOnePartner);
      return;
    }
    const res = await fetch('/api/admin/affiliate/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partnerId: partnerIds[0],
        commissionIds: selected,
        paidAt: new Date(payDate).toISOString(),
        reference: payRef.trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok ? `${a.msgPaid}: ${eur(data.amountMinor)}.` : `${a.msgNotPaid}: ${data.error ?? res.status}.`);
    if (res.ok) {
      setSelected([]);
      setPayRef('');
      await load();
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">{a.title}</h1>
      {message && <p role="status" className="text-sm">{message}</p>}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{a.recordTitle}</h2>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            recordPayment(e.currentTarget);
          }}
        >
          <select name="partnerId" required className="rounded border p-2" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">{a.partner}</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.user.fullName}</option>
            ))}
          </select>
          <input name="externalCustomerRef" required placeholder={a.customerRef} className="rounded border p-2" />
          <input name="amount" required type="number" step="0.01" min="0.01" placeholder={a.amount} className="rounded border p-2" />
          <input name="receivedAt" required type="datetime-local" aria-label={a.receivedAt} className="rounded border p-2" />
          <input name="externalPaymentRef" required placeholder={a.paymentRef} className="rounded border p-2 md:col-span-2" />
          <button type="submit" className="rounded bg-black px-4 py-2 text-white md:col-span-2 md:w-fit">{a.recordButton}</button>
        </form>
      </section>

      {partnerId && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">{a.bankTitle}</h2>
          {details && (
            <p className="text-sm">{details.accountHolder} · <span className="font-mono">{details.iban}</span></p>
          )}
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveDetails(e.currentTarget);
            }}
          >
            <input name="accountHolder" required placeholder={a.accountHolder} className="rounded border p-2" />
            <input name="iban" required placeholder={a.iban} className="rounded border p-2" />
            <button type="submit" className="rounded border px-4 py-2 md:w-fit">{a.saveBank}</button>
          </form>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{a.unpaidTitle}</h2>
        {openCommissions.length === 0 ? (
          <p className="text-sm">{a.nothingToPay}</p>
        ) : (
          <>
            <ul className="space-y-1 text-sm">
              {openCommissions.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(p.commission!.id)}
                      onChange={() => toggle(p.commission!.id)}
                    />
                    {p.customer.partner.code} · {p.customer.externalRef} · {p.commission!.kind} · {eur(p.commission!.amountMinor)} · {p.commission!.status}
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <input type="date" aria-label={a.transferDate} value={payDate} onChange={(e) => setPayDate(e.target.value)} className="rounded border p-2" />
              <input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder={a.transferRef} className="rounded border p-2" />
              <button type="button" onClick={markPaid} disabled={selected.length === 0} className="rounded border px-4 py-2 disabled:opacity-50">
                {a.markPaid} ({selected.length})
              </button>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">{a.recentTitle}</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">{a.colReceived}</th>
              <th className="p-2">{a.colPartner}</th>
              <th className="p-2">{a.colCustomer}</th>
              <th className="p-2">{a.colAmount}</th>
              <th className="p-2">{a.colReference}</th>
              <th className="p-2">{a.colCommission}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-2">{new Date(p.receivedAt).toLocaleDateString()}</td>
                <td className="p-2">{p.customer.partner.code}</td>
                <td className="p-2">{p.customer.externalRef}</td>
                <td className="p-2">{eur(p.amountMinor)}</td>
                <td className="p-2">{p.externalPaymentRef ?? '—'}</td>
                <td className="p-2">{p.commission ? `${eur(p.commission.amountMinor)} (${p.commission.status})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
