'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Briefcase, PartyPopper } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/relativeTime';
import { DECLINE_REASON_CODES } from '@/lib/offers';

interface Offer {
  id: string;
  status: string;
  position: string;
  startDate: string | null;
  expiresAt: string | null;
  compensationNote?: string | null;
  declineReasonCode: string | null;
  company: { id: string; name: string } | null;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).setHours(23, 59, 59, 999) - Date.now();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// Mentee-facing offer card on /portal (#809): shows the candidate's current
// offer and, once they've decided, a persistent accepted/declined state
// (not just a toast) rather than reverting to "no offer" after the action.
export function OfferCard() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineNote, setDeclineNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/offers');
    if (!res.ok) {
      setOffer(null);
      return;
    }
    const data = await res.json();
    const offers: Offer[] = data.offers ?? [];
    // Prefer an offer the mentee still needs to act on; otherwise fall back
    // to the most recently decided one so the persistent state keeps showing.
    const current = offers.find((o) => o.status === 'SENT') ?? offers[0] ?? null;
    setOffer(current);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (offer === undefined || offer === null) return null;

  const act = async (action: 'accept' | 'decline', extra?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/offers/${offer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      if (!res.ok) throw new Error();
      await load();
      setConfirmAccept(false);
      setDeclining(false);
    } catch {
      toast(t.portal.offer.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  const companySuffix = offer.company ? ` (${offer.company.name})` : '';

  if (offer.status === 'ACCEPTED' || offer.status === 'DECLINED') {
    const accepted = offer.status === 'ACCEPTED';
    return (
      <Card data-testid="offer-card-decided">
        <div className="flex items-start gap-3">
          {accepted ? <PartyPopper className="h-6 w-6 text-green-600 flex-shrink-0" /> : <Briefcase className="h-6 w-6 text-gray-400 flex-shrink-0" />}
          <div>
            <p className="font-semibold text-gray-900 dark:text-gray-100">
              {accepted ? t.portal.offer.acceptedTitle : t.portal.offer.declinedTitle}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              {(accepted ? t.portal.offer.acceptedBody : t.portal.offer.declinedBody).replace('{position}', offer.position)}
            </p>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mt-3">{t.portal.offer.whatsNext}</p>
            <p className="text-sm text-gray-500">{accepted ? t.portal.offer.whatsNextAccepted : t.portal.offer.whatsNextDeclined}</p>
          </div>
        </div>
      </Card>
    );
  }

  if (offer.status !== 'SENT') {
    // EXPIRED / WITHDRAWN — informational only, no action available.
    return (
      <Card data-testid="offer-card-closed">
        <div className="flex items-center justify-between">
          <p className="font-medium text-gray-900 dark:text-gray-100">{offer.position}</p>
          <Badge variant="default">{(t.offers.status as Record<string, string>)[offer.status] ?? offer.status}</Badge>
        </div>
      </Card>
    );
  }

  const days = offer.expiresAt ? daysUntil(offer.expiresAt) : null;
  const deadlineText =
    days === null
      ? null
      : days < 0
        ? t.portal.offer.overdue
        : days === 0
          ? t.portal.offer.dueToday
          : days === 1
            ? t.portal.offer.dueTomorrow
            : t.portal.offer.daysLeft.replace('{n}', String(days));

  return (
    <Card data-testid="offer-card">
      <CardHeader>
        <CardTitle>{t.portal.offer.title}</CardTitle>
      </CardHeader>
      <div className="space-y-2">
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{offer.position}</p>
        {offer.company && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            <span className="text-gray-400">{t.portal.offer.company}:</span> {offer.company.name}
          </p>
        )}
        {offer.startDate && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            <span className="text-gray-400">{t.portal.offer.startDate}:</span> {formatDate(offer.startDate, locale)}
          </p>
        )}
        {offer.expiresAt && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            <span className="text-gray-400">{t.portal.offer.decideBy}:</span> {formatDate(offer.expiresAt, locale)}
          </p>
        )}
        {deadlineText && (
          <Badge variant={days !== null && days <= 1 ? 'warning' : 'info'} data-testid="offer-deadline-badge">
            {deadlineText}
          </Badge>
        )}
        {offer.compensationNote && (
          <div className="pt-1">
            <p className="text-xs text-gray-400">{t.portal.offer.compensation}</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{offer.compensationNote}</p>
          </div>
        )}
      </div>

      {!declining ? (
        <div className="mt-5 flex flex-col sm:flex-row gap-2">
          <Button size="lg" className="flex-1" data-testid="offer-accept-button" onClick={() => setConfirmAccept(true)}>
            {t.portal.offer.accept}
          </Button>
          <Button size="lg" variant="outline" className="flex-1" data-testid="offer-decline-button" onClick={() => setDeclining(true)}>
            {t.portal.offer.decline}
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-3 rounded-lg border border-gray-100 dark:border-gray-700 p-3" data-testid="offer-decline-form">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t.portal.offer.declineTitle}</p>
          <Select
            label={t.portal.offer.declineReasonLabel}
            data-testid="offer-decline-reason"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            options={DECLINE_REASON_CODES.map((code) => ({
              value: code,
              label: (t.offerDeclineReasons as Record<string, string>)[code] ?? code,
            }))}
            placeholder={t.portal.offer.declineReasonLabel}
          />
          <Textarea
            aria-label={t.portal.offer.declineNoteLabel}
            placeholder={t.portal.offer.declineNotePlaceholder}
            maxLength={1000}
            value={declineNote}
            onChange={(e) => setDeclineNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setDeclining(false)}>
              {t.portal.offer.cancel}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!declineReason}
              data-testid="offer-decline-submit"
              onClick={() => act('decline', { declineReasonCode: declineReason, declineNote: declineNote.trim() || undefined })}
            >
              {t.portal.offer.submitDecline}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmAccept}
        title={t.portal.offer.confirmAcceptTitle}
        message={t.portal.offer.confirmAcceptBody.replace('{position}', offer.position).replace('{company}', companySuffix)}
        confirmLabel={t.portal.offer.confirmAcceptCta}
        cancelLabel={t.portal.offer.cancel}
        loading={busy}
        onConfirm={() => act('accept')}
        onCancel={() => setConfirmAccept(false)}
      />
    </Card>
  );
}
