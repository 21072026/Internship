'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// Mentor Offers (#1809), the mentee's side on /portal: the opt-in switch
// ("mentors may offer to mentor me", off by default) and any open offers, each
// with Accept and Decline. Declining needs no reason. Shown only to a mentee
// without a live mentorship — the same branch as the request panel.

interface PortalOffer {
  id: string;
  message: string | null;
  expiresAt: string;
  mentor: { id: string; fullName: string; displayName: string | null; bio: string | null; publicProfile: boolean };
}

export function MentorOffersPortalPanel() {
  const t = useT();
  const router = useRouter();
  const locale = useLocale();
  const L = t.mentorOffers;
  const [open, setOpen] = useState<boolean | null>(null);
  const [offers, setOffers] = useState<PortalOffer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOpen(d?.user?.openToOffers === true))
      .catch(() => setOpen(false));
    fetch('/api/mentee/offers')
      .then((r) => (r.ok ? r.json() : { offers: [] }))
      .then((d) => setOffers(d.offers ?? []))
      .catch(() => setOffers([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async () => {
    if (open === null) return;
    setBusy('toggle');
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openToOffers: !open }),
      });
      if (res.ok) setOpen(!open);
    } finally {
      setBusy(null);
    }
  };

  const answer = async (id: string, action: 'accept' | 'decline') => {
    setBusy(id);
    setFlash(null);
    try {
      const res = await fetch(`/api/mentee/offers/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setOffers((prev) => prev.filter((o) => o.id !== id));
        setFlash(action === 'accept' ? L.accepted : L.declined);
        // The page is a server component: re-render it so the new mentor shows.
        if (action === 'accept') router.refresh();
      } else {
        setFlash(t.common.error);
        load();
      }
    } finally {
      setBusy(null);
    }
  };

  if (open === null) return null;
  return (
    <Card className="mb-6" data-testid="mentor-offers-portal">
      <CardHeader><CardTitle>{L.portalTitle}</CardTitle></CardHeader>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{L.optInLabel}</p>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{L.optInHint}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={open}
          aria-label={L.optInLabel}
          disabled={busy === 'toggle'}
          onClick={toggle}
          data-testid="open-to-offers-toggle"
          className="relative inline-block h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <span className={`absolute inset-0 rounded-full transition-colors ${open ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'}`} />
          <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${open ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>
      {flash && <p className="mt-3 text-sm text-gray-700 dark:text-gray-200" role="status">{flash}</p>}
      {offers.length > 0 && (
        <ul className="mt-4 space-y-3">
          {offers.map((o) => (
            <li key={o.id} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3" data-testid={`portal-offer-${o.id}`}>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {L.offerFrom.replace('{name}', o.mentor.displayName || o.mentor.fullName)}
              </p>
              {o.message && <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{o.message}</p>}
              <p className="mt-1 text-xs text-gray-500">{L.expires.replace('{date}', formatDate(o.expiresAt, locale))}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" loading={busy === o.id} onClick={() => answer(o.id, 'accept')} data-testid={`portal-offer-accept-${o.id}`}>
                  {L.accept}
                </Button>
                <Button size="sm" variant="outline" disabled={busy === o.id} onClick={() => answer(o.id, 'decline')} data-testid={`portal-offer-decline-${o.id}`}>
                  {L.decline}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
