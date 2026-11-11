'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { availableVerificationActions, type VerificationAction } from '@/lib/companyVerification';

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  VERIFIED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
};

const NEEDS_REASON: ReadonlySet<VerificationAction> = new Set(['reject', 'suspend']);

// The employer-verification badge and the admin's decision buttons on a company
// card (#1865). A VERIFIED company shows no badge — that is every company that
// existed before verification did — only the suspend action. Whether a move is
// allowed is decided by POST /api/admin/companies/[id]/verification; the
// buttons only offer the same list (`availableVerificationActions()`).
export function CompanyVerificationControl({
  companyId,
  status,
  reason,
  onChanged,
}: {
  companyId: string;
  status: string;
  reason?: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  const v = t.companiesPage.verification;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(action: VerificationAction) {
    let body: { action: VerificationAction; reason?: string } = { action };
    if (NEEDS_REASON.has(action)) {
      const typed = window.prompt(v.reasonPrompt)?.trim();
      if (!typed) return;
      body = { action, reason: typed };
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage(data?.code === 'state_conflict' ? v.conflict : v.refused);
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const actions = availableVerificationActions(status);
  return (
    <div className="mb-3 space-y-2" data-testid={`company-verification-${companyId}`}>
      <div className="flex flex-wrap items-center gap-2">
        {status !== 'VERIFIED' && (
          <Badge variant={STATUS_VARIANT[status] ?? 'default'} data-testid={`company-verification-status-${companyId}`}>
            {v.statuses[status as keyof typeof v.statuses] ?? status}
          </Badge>
        )}
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => void act(action)}
            data-testid={`company-verification-${action}-${companyId}`}
            className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
          >
            {v.actions[action]}
          </button>
        ))}
      </div>
      {reason && status !== 'VERIFIED' && <p className="text-xs text-gray-500">{v.reasonLabel}: {reason}</p>}
      {message && <p role="alert" className="text-xs text-red-600">{message}</p>}
    </div>
  );
}
