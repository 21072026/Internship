'use client';

import { useState } from 'react';
import { UserX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

/**
 * "Forget this contact" for a person who never had an account (#2559) —
 * `POST /api/admin/company-contacts/forget`. The same two gates as
 * UserEraseForm, adapted: there is no name to confirm, so the address is typed
 * again (a misclick guard), and the admin's OWN password is the step-up. The
 * server scrubs every enquiry and company contact with this address in the
 * admin's tenant; the companies themselves stay.
 */
export function ContactForgetForm({ email, onDone }: { email: string; onDone: () => void }) {
  const t = useT();
  const c = t.erasure;
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setOpen(false);
    setConfirmEmail('');
    setAdminPassword('');
    setError('');
  };

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/company-contacts/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, confirmEmail, adminPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.code === 'has_account' ? c.forgetContactHasAccount : body.error || c.failed);
        return;
      }
      setAdminPassword('');
      onDone();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="forget-contact-open"
        className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:underline"
      >
        <UserX className="h-4 w-4" /> {c.forgetContact}
      </button>
    );
  }

  return (
    <div className="space-y-3 max-w-md" data-testid="forget-contact-form">
      <p className="text-sm text-red-700 dark:text-red-400">{c.forgetContactConfirm}</p>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          {c.forgetContactTypeEmail.replace('{email}', email)}
        </label>
        <input
          type="email"
          data-testid="forget-contact-confirm-email"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{c.adminPassword}</label>
        <input
          type="password"
          autoComplete="current-password"
          data-testid="forget-contact-admin-password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
        <p className="text-xs text-gray-400 mt-1">{c.adminPasswordHint}</p>
      </div>
      {error && <p className="text-xs text-red-600" data-testid="forget-contact-error">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          disabled={!confirmEmail.trim() || !adminPassword}
          onClick={run}
          data-testid="forget-contact-submit"
        >
          {c.forgetContactYes}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel} disabled={busy}>
          {t.common.cancel}
        </Button>
      </div>
    </div>
  );
}
