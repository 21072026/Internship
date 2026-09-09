'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useT } from '@/i18n/client';

export interface ConvertibleInquiry {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
}

/**
 * "Convert to account" (#1863) — the prefilled, editable form behind the button
 * on an enquiry row.
 *
 * Two things it must not do, both of which the API guarantees and this UI has to
 * keep faithful:
 *
 *   - It never shows a credential. The invitee sets their own password from a
 *     link that only ever exists in their mailbox, so there is nothing here to
 *     copy and nothing to leak on a screen share.
 *   - It never claims the account is reachable when the invitation did not go
 *     out. `emailSent: false` gets its own message telling the admin to resend,
 *     because "created" on its own is how somebody ends up waiting for a mail
 *     that was never sent (#987/#1431).
 */
export function ConvertInquiryModal({
  inquiry,
  onClose,
  onConverted,
}: {
  inquiry: ConvertibleInquiry;
  onClose: () => void;
  /** Called after a successful conversion so the list can pick up the new state. */
  onConverted: () => void;
}) {
  const t = useT();
  const c = t.companyInquiriesAdmin.convert;
  const [companyName, setCompanyName] = useState(inquiry.companyName);
  const [contactFullName, setContactFullName] = useState(inquiry.contactName);
  const [email, setEmail] = useState(inquiry.email);
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);

  const fill = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce((out, [key, value]) => out.split(`{${key}}`).join(value), template);

  const submit = async () => {
    // Belt and braces against the double-click: the button is disabled while the
    // request is in flight, and the server refuses a second conversion anyway.
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/company-inquiries/${inquiry.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          contactFullName,
          email,
          ...(industry.trim() ? { industry } : {}),
          ...(size.trim() ? { size } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setSuccess(
          data.emailSent === false
            ? fill(c.successNoEmail, { company: data.companyName ?? companyName, email: data.email ?? email })
            : fill(c.success, { company: data.companyName ?? companyName, email: data.email ?? email })
        );
        onConverted();
        return;
      }
      if (data.error === 'already_converted') {
        setError(
          data.companyName
            ? fill(c.alreadyConverted, { company: data.companyName })
            : c.alreadyConvertedUnnamed
        );
        // The row is stale — it is offering an action the enquiry no longer has.
        onConverted();
        return;
      }
      if (data.error === 'email_taken') {
        setError(
          data.companyName
            ? fill(c.emailTaken, { email, company: data.companyName })
            : fill(c.emailTakenNoCompany, { email })
        );
        return;
      }
      setError(c.failed);
    } catch {
      setError(c.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-inquiry-title"
        tabIndex={-1}
        data-testid="convert-inquiry-dialog"
        className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <h2 id="convert-inquiry-title" className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {c.title}
        </h2>

        {success ? (
          <div className="mt-4 space-y-4">
            <p
              data-testid="convert-inquiry-success"
              className="bg-green-50 text-green-800 rounded-lg p-3 text-sm"
            >
              {success}
            </p>
            <div className="flex justify-end gap-2">
              <a
                href="/admin/companies"
                className="inline-flex items-center text-sm text-blue-600 hover:underline px-3 py-2"
              >
                {c.openCompany}
              </a>
              <Button type="button" onClick={onClose} data-testid="convert-inquiry-done">
                {c.done}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mt-1">{c.intro}</p>
            <div className="mt-4 space-y-3">
              <Input
                label={c.companyName}
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                data-testid="convert-company-name"
                required
              />
              <Input
                label={c.contactFullName}
                value={contactFullName}
                onChange={(e) => setContactFullName(e.target.value)}
                data-testid="convert-contact-name"
                required
              />
              <Input
                label={c.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="convert-email"
                required
              />
              <Input
                label={`${c.industry} (${c.optional})`}
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                data-testid="convert-industry"
              />
              <Input
                label={`${c.size} (${c.optional})`}
                value={size}
                onChange={(e) => setSize(e.target.value)}
                data-testid="convert-size"
              />
            </div>

            {error && (
              <p data-testid="convert-inquiry-error" className="mt-4 bg-red-50 text-red-700 rounded-lg p-3 text-sm">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                {c.cancel}
              </Button>
              <Button
                type="button"
                onClick={submit}
                loading={busy}
                disabled={busy || !companyName.trim() || !contactFullName.trim() || !email.trim()}
                data-testid="convert-inquiry-submit"
              >
                {busy ? c.submitting : c.submit}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
