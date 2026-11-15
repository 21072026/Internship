'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';

// Entering new bank details (#3117). The fields are emptied after a save: the
// full IBAN is never read back, so the form never shows it again.
//
// Every save asks the account holder to confirm themselves (#3734): the code
// from their authenticator (or a recovery code) when they have 2FA, else their
// current password — `stepUp` comes from the server (src/lib/stepUp.ts), and
// null means neither exists (an SSO-only account without 2FA), so there is no
// form, only the way to enrol.
export function PayoutDetailsForm({
  impersonating,
  suspended,
  stepUp,
}: {
  impersonating: boolean;
  suspended: boolean;
  stepUp: 'totp' | 'password' | null;
}) {
  const L = useT().affiliatePortal;
  const router = useRouter();
  const toast = useToast();
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [proof, setProof] = useState('');
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  if (impersonating) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.detailsErrors.impersonating}</p>;
  if (suspended) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.detailsErrors.partner_suspended}</p>;
  if (!stepUp) return <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-step-up-unavailable">{L.detailsErrors.step_up_unavailable}</p>;

  async function save() {
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/affiliate/me/payout-details', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iban, holder, stepUp: stepUp === 'totp' ? { code: proof } : { password: proof } }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.detailsSaved);
        setIban('');
        setHolder('');
        setProof('');
        router.refresh();
        return;
      }
      if (body.code === 'invalid_input') {
        setIssues(new Set(body.issues ?? []));
        return;
      }
      // A refused proof is never kept: a code is single-use, a password is not left in the field.
      if (typeof body.code === 'string' && body.code.startsWith('step_up_')) setProof('');
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
      <div className="space-y-1 sm:max-w-sm">
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.stepUpHint}</p>
        <Input
          label={stepUp === 'totp' ? L.stepUpCode : L.stepUpPassword}
          type={stepUp === 'totp' ? 'text' : 'password'}
          inputMode={stepUp === 'totp' ? 'text' : undefined}
          autoComplete={stepUp === 'totp' ? 'one-time-code' : 'current-password'}
          spellCheck={false}
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          data-testid="affiliate-step-up"
        />
      </div>
      <Button type="button" disabled={busy || !iban.trim() || !holder.trim() || !proof.trim()} onClick={() => void save()} data-testid="affiliate-save-details">
        {L.saveDetails}
      </Button>
    </div>
  );
}
