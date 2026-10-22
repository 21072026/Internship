'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileSignature } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { templateToHtml } from '@/lib/renderTemplate';
import type { AgreementStatus } from '@/lib/mentoringAgreementRule';

// The mentoring agreement at kickoff (#1792), on the mentee portal and the
// mentor's mentee detail. A PROMPT, NOT A GATE: this card is the only thing a
// missing acceptance changes — nothing else on either screen is disabled, and
// nothing may be (src/lib/mentoringAgreementRule.ts). The click-wrap rules are
// the contributor terms' (ContributorTermsAccept): the box starts unticked, the
// button waits for it, and the version on screen is sent so a changed text is
// refused (409) instead of being recorded as consent to unseen wording.

export interface AgreementBlock {
  version: string;
  locale: string;
  authoritativeLocale: string | null;
  body: string;
  mentorAcceptedAt: string | null;
  menteeAcceptedAt: string | null;
  status: AgreementStatus;
  seat: 'MENTOR' | 'MENTEE' | null;
  viewerAcceptedAt: string | null;
  viewerAcceptedEarlier: boolean;
}

export function AgreementCard({ relationId, agreement, onAccepted }: { relationId: string; agreement: AgreementBlock; onAccepted?: () => void }) {
  const t = useT();
  const C = t.agreementCard;
  const locale = useLocale();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // An admin reading the relation sees the status, never an accept button.
  if (!agreement.seat) return null;

  const fmt = (iso: string) => new Date(iso).toLocaleDateString(intlLocaleFor(locale), { year: 'numeric', month: 'long', day: 'numeric' });
  const otherAt = agreement.seat === 'MENTOR' ? agreement.menteeAcceptedAt : agreement.mentorAcceptedAt;
  const text = (
    <div className="prose prose-sm max-w-none text-gray-700 dark:prose-invert" data-testid="agreement-text" dangerouslySetInnerHTML={{ __html: templateToHtml(agreement.body) }} />
  );

  if (agreement.viewerAcceptedAt) {
    return (
      <Card className="mb-6" data-testid="agreement-card" data-state="accepted">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2 aria-hidden className="h-4 w-4 text-green-600" />
          <span className="text-gray-700 dark:text-gray-200">{C.agreedOn.replace('{date}', fmt(agreement.viewerAcceptedAt)).replace('{version}', agreement.version)}</span>
          <span className="text-gray-400">·</span>
          <span className="text-gray-500">{C.otherSide.replace('{status}', otherAt ? C.status.SIGNED : C.status.UNSIGNED)}</span>
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-blue-600 hover:underline" data-testid="agreement-view">{open ? C.hide : C.view}</button>
        </div>
        {open && <div className="mt-3">{text}</div>}
      </Card>
    );
  }

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mentorship/${encodeURIComponent(relationId)}/agreement/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: agreement.version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setChecked(false);
        setError(body.code === 'stale_version' ? C.stale : C.failed);
        if (body.code === 'stale_version') router.refresh();
        return;
      }
      if (onAccepted) onAccepted();
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6 border-blue-200 dark:border-blue-800" data-testid="agreement-card" data-state="pending">
      <div className="mb-3 flex items-center gap-2">
        <FileSignature aria-hidden className="h-5 w-5 text-blue-600" />
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">{C.title}</h2>
      </div>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{agreement.viewerAcceptedEarlier ? C.updated : C.intro}</p>
      {/* Scrollable, so it takes keyboard focus (axe scrollable-region-focusable). */}
      <div tabIndex={0} role="region" aria-label={C.title} className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 p-3 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700">{text}</div>
      {agreement.authoritativeLocale && (
        <p className="mt-2 text-xs text-gray-500">{C.translationNote.replace('{locale}', agreement.authoritativeLocale.toUpperCase())}</p>
      )}
      <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" data-testid="agreement-checkbox" />
        <span>{C.checkbox}</span>
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      <Button className="mt-3" onClick={accept} disabled={!checked} loading={busy} data-testid="agreement-accept">{C.accept}</Button>
    </Card>
  );
}
