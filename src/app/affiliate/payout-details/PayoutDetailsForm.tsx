'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';

// Entering new bank details (#3117). The fields are emptied after a save: the
// full IBAN is never read back, so the form never shows it again.
export function PayoutDetailsForm({ impersonating, suspended }: { impersonating: boolean; suspended: boolean }) {
  const L = useT().affiliatePortal;
  const router = useRouter();
  const toast = useToast();
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  if (impersonating) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.detailsErrors.impersonating}</p>;
  if (suspended) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.detailsErrors.partner_suspended}</p>;

  async function save() {
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/affiliate/me/payout-details', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iban, holder }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.detailsSaved);
        setIban('');
        setHolder('');
        router.refresh();
        return;
      }
      if (body.code === 'invalid_input') {
        setIssues(new Set(body.issues ?? []));
        return;
      }
      const code = body.code as keyof typeof L.detailsErrors | undefined;
      toast(code && code in L.detailsErrors ? L.detailsErrors[code] : L.contractFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-private>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label={L.iban}
          autoComplete="off"
          spellCheck={false}
          value={iban}
          error={issues.has('iban') ? L.detailsErrors.iban : undefined}
          onChange={(e) => setIban(e.target.value)}
          data-testid="affiliate-iban"
        />
        <Input
          label={L.holder}
          autoComplete="name"
          value={holder}
          error={issues.has('holder') ? L.detailsErrors.holder : undefined}
          onChange={(e) => setHolder(e.target.value)}
          data-testid="affiliate-holder"
        />
      </div>
      <Button type="button" disabled={busy || !iban.trim() || !holder.trim()} onClick={() => void save()} data-testid="affiliate-save-details">
        {L.saveDetails}
      </Button>
    </div>
  );
}
