'use client';

import { useCallback, useEffect, useState } from 'react';
import { HeartHandshake } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { RelativeTime } from '@/components/ui/RelativeTime';

// Mentor Offers (#1809), the mentor's side: mentees who OPTED IN to being
// offered mentorship and are still unmatched, an offer form with an optional
// message, and the mentor's own offers with a withdraw action. The quota
// (3 pending, 5 per 7 days) is shown here and enforced by the server.

interface Offerable {
  id: string;
  fullName: string;
  displayName: string | null;
  university: string | null;
  department: string | null;
  city: string | null;
  skills: unknown;
  interests: string | null;
  targetPosition: string | null;
}

interface OwnOffer {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
  expiresAt: string;
  createdAt: string;
  mentee: { id: string; fullName: string; displayName: string | null };
}

interface Quota {
  pending: number;
  maxPending: number;
  sentLast7Days: number;
  maxPerWeek: number;
}

const STATUS_VARIANT: Record<OwnOffer['status'], 'warning' | 'success' | 'default'> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'default',
  EXPIRED: 'default',
  WITHDRAWN: 'default',
};

export default function MentorOffersPage() {
  const t = useT();
  const L = t.mentorOffers;
  const [data, setData] = useState<{ offers: OwnOffer[]; offerable: Offerable[]; quota: Quota } | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/mentor/offers')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d ?? { offers: [], offerable: [], quota: { pending: 0, maxPending: 3, sentLast7Days: 0, maxPerWeek: 5 } }))
      .catch(() => setData({ offers: [], offerable: [], quota: { pending: 0, maxPending: 3, sentLast7Days: 0, maxPerWeek: 5 } }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const send = async (menteeId: string) => {
    setBusy(menteeId);
    setFlash(null);
    try {
      const res = await fetch('/api/mentor/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId, message: message.trim() || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setFlash(L.sent);
        setDrafting(null);
        setMessage('');
        load();
      } else {
        setFlash((L.refusals as Record<string, string>)[d.code] ?? t.common.error);
      }
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/mentor/offers/${id}`, { method: 'DELETE' });
      if (res.ok) load();
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = (s: OwnOffer['status']) => L.status[s];
  const quotaFull = data ? data.quota.pending >= data.quota.maxPending || data.quota.sentLast7Days >= data.quota.maxPerWeek : false;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <HeartHandshake className="h-6 w-6" aria-hidden /> {L.title}
        </h1>
        <p className="text-gray-500 mt-1">{L.subtitle}</p>
      </div>

      {flash && (
        <p className="mb-4 text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="mentor-offers-flash">
          {flash}
        </p>
      )}

      {data === null ? (
        <p className="text-gray-400 py-8 text-center">…</p>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{L.offerableTitle}</CardTitle></CardHeader>
            <p className="text-xs text-gray-500 mb-3" data-testid="mentor-offers-quota">
              {L.quota
                .replace('{pending}', String(data.quota.pending))
                .replace('{maxPending}', String(data.quota.maxPending))
                .replace('{week}', String(data.quota.sentLast7Days))
                .replace('{maxPerWeek}', String(data.quota.maxPerWeek))}
            </p>
            {data.offerable.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">{L.noneOfferable}</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.offerable.map((m) => (
                  <li key={m.id} className="py-3" data-testid={`mentor-offerable-${m.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{m.displayName || m.fullName}</p>
                        <p className="text-xs text-gray-500">
                          {[m.targetPosition, m.university, m.department, m.city].filter(Boolean).join(' · ')}
                        </p>
                        {Array.isArray(m.skills) && m.skills.length > 0 && (
                          <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{(m.skills as string[]).join(', ')}</p>
                        )}
                      </div>
                      {drafting !== m.id && (
                        <Button size="sm" variant="outline" disabled={quotaFull} onClick={() => setDrafting(m.id)} data-testid={`mentor-offer-open-${m.id}`}>
                          {L.offer}
                        </Button>
                      )}
                    </div>
                    {drafting === m.id && (
                      <div className="mt-2 space-y-2">
                        <Textarea rows={3} maxLength={1000} value={message} placeholder={L.messagePlaceholder} onChange={(e) => setMessage(e.target.value)} aria-label={L.messageLabel} />
                        <div className="flex gap-2">
                          <Button size="sm" loading={busy === m.id} onClick={() => send(m.id)} data-testid={`mentor-offer-send-${m.id}`}>
                            {L.send}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDrafting(null)}>
                            {t.common.cancel}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{L.mineTitle}</CardTitle></CardHeader>
            {data.offers.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">{L.noneMine}</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.offers.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-2" data-testid={`mentor-offer-${o.id}`}>
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900 dark:text-gray-100">{o.mentee.displayName || o.mentee.fullName}</p>
                      <p className="text-xs text-gray-500">
                        <RelativeTime date={o.createdAt} />
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[o.status]}>{statusLabel(o.status)}</Badge>
                      {o.status === 'PENDING' && (
                        <Button size="sm" variant="outline" loading={busy === o.id} onClick={() => withdraw(o.id)}>
                          {L.withdraw}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
