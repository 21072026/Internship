'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import type { ContactBasis, ContactChannel } from '@/lib/contactPermissionRule';

// The ADMIN's contact-permission editor on /admin/companies/[id] (#2577). It
// offers only what the rule lets an admin write — a §7(3) existing-customer
// record with its reason, "reply to their request only", or no basis — plus a
// revocation. DOI_CONFIRMED is not in the list on purpose: only the address
// owner's own click can produce it (src/lib/contactPermissionRule.ts).

const ADMIN_BASES: ContactBasis[] = ['EXISTING_CUSTOMER_7_3', 'INQUIRY_REPLY', 'NONE'];
const CHANNELS: ContactChannel[] = ['EMAIL', 'PHONE', 'POST'];

export interface ContactPermissionEditorLabels {
  title: string;
  channel: string;
  basis: string;
  reason: string;
  reasonHint: string;
  save: string;
  revoke: string;
  saved: string;
  failed: string;
  reasonRequired: string;
  doiHint: string;
  objected: string;
  channels: Record<ContactChannel, string>;
  bases: Record<ContactBasis, string>;
}

export function ContactPermissionEditor({ companyId, labels }: { companyId: string; labels: ContactPermissionEditorLabels }) {
  const router = useRouter();
  const [channel, setChannel] = useState<ContactChannel>('EMAIL');
  const [basis, setBasis] = useState<ContactBasis>('EXISTING_CUSTOMER_7_3');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed' | 'reason' | 'objected'>('idle');

  // §7(3) is an e-mail rule; for the other channels only the neutral bases apply.
  const bases = channel === 'EMAIL' ? ADMIN_BASES : ADMIN_BASES.filter((b) => b !== 'EXISTING_CUSTOMER_7_3');

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setStatus('idle');
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/contact-permission`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setStatus('saved');
        setReason('');
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setStatus(data?.code === 'reason_required' ? 'reason' : data?.code === 'owner_objected' ? 'objected' : 'failed');
    } catch {
      setStatus('failed');
    } finally {
      setBusy(false);
    }
  };

  const effectiveBasis = bases.includes(basis) ? basis : bases[0];

  return (
    <form
      className="mt-4 space-y-3 border-t border-gray-100 pt-4"
      data-testid="contact-permission-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void send({ action: 'set', channel, basis: effectiveBasis, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      }}
    >
      <p className="text-sm font-medium text-gray-700">{labels.title}</p>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-gray-500">
          {labels.channel}
          <select
            className="mt-1 block rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
            value={channel}
            data-testid="contact-permission-channel"
            onChange={(e) => setChannel(e.target.value as ContactChannel)}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {labels.channels[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-500">
          {labels.basis}
          <select
            className="mt-1 block rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
            value={effectiveBasis}
            data-testid="contact-permission-basis"
            onChange={(e) => setBasis(e.target.value as ContactBasis)}
          >
            {bases.map((b) => (
              <option key={b} value={b}>
                {labels.bases[b]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {effectiveBasis === 'EXISTING_CUSTOMER_7_3' && (
        <label className="block text-xs text-gray-500">
          {labels.reason}
          <textarea
            className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
            rows={2}
            maxLength={1000}
            value={reason}
            data-testid="contact-permission-reason"
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="mt-1 block">{labels.reasonHint}</span>
        </label>
      )}
      <p className="text-xs text-gray-500">{labels.doiHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={busy} data-testid="contact-permission-save">
          {labels.save}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="contact-permission-revoke"
          onClick={() => void send({ action: 'revoke', channel })}
        >
          {labels.revoke}
        </Button>
        {status === 'saved' && <span className="text-sm text-green-700" data-testid="contact-permission-saved">{labels.saved}</span>}
        {status === 'failed' && <span className="text-sm text-red-700">{labels.failed}</span>}
        {status === 'objected' && <span className="text-sm text-red-700" data-testid="contact-permission-objected">{labels.objected}</span>}
        {status === 'reason' && <span className="text-sm text-red-700" data-testid="contact-permission-reason-required">{labels.reasonRequired}</span>}
      </div>
    </form>
  );
}
