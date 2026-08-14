'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OfferWizardModal, type OfferDraftFields } from '@/components/OfferWizardModal';
import { Plus, History, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/relativeTime';
import { DEFAULT_HIRED_STAGE_KEY } from '@/lib/offers';
import type { ResolvedStage } from '@/lib/pipeline';

interface Offer {
  id: string;
  status: string;
  position: string;
  startDate: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  declineReasonCode: string | null;
  declineNote: string | null;
  compensationNote?: string | null;
  requisitionId: string | null;
  company: { id: string; name: string } | null;
  createdAt: string;
}

interface HistoryEntry {
  id: string;
  action: string;
  detail: string | null;
  actorId: string;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'> = {
  DRAFT: 'default',
  SENT: 'info',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'default',
  WITHDRAWN: 'default',
};

interface OfferManagementPanelProps {
  relationId: string;
  menteeName: string;
  companyName?: string | null;
  pipelineStatus: string;
  stages: ResolvedStage[];
  onMoveToStage: (stageKey: string) => void | Promise<void>;
}

// Admin-facing offer management, embedded in the candidate detail page's
// Mentorship card (#809): create (3-step wizard), send, withdraw, and a
// per-offer history timeline. Only surfaces the "move to hired stage"
// suggestion when the org's resolved pipeline actually has that stage —
// custom pipelines that dropped/renamed it simply never see it.
export function OfferManagementPanel({
  relationId,
  menteeName,
  companyName,
  pipelineStatus,
  stages,
  onMoveToStage,
}: OfferManagementPanelProps) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<OfferDraftFields | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: 'send' | 'withdraw' } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, HistoryEntry[]>>({});
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [movingStage, setMovingStage] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/offers?relationId=${relationId}`);
    if (res.ok) setOffers((await res.json()).offers ?? []);
    setLoading(false);
  }, [relationId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleHistory = async (id: string) => {
    if (historyOpenId === id) {
      setHistoryOpenId(null);
      return;
    }
    setHistoryOpenId(id);
    if (!historyById[id]) {
      const res = await fetch(`/api/offers/${id}`);
      if (res.ok) {
        const data = await res.json();
        setHistoryById((m) => ({ ...m, [id]: data.offer.history ?? [] }));
      }
    }
  };

  const runAction = async (id: string, action: 'send' | 'withdraw') => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/offers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error();
      await load();
      toast(t.offers.saved);
    } catch {
      toast(t.offers.saveError, 'error');
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const openEdit = (o: Offer) => {
    setEditing({
      id: o.id,
      position: o.position,
      requisitionId: o.requisitionId ?? '',
      startDate: o.startDate ? o.startDate.slice(0, 10) : '',
      compensationNote: o.compensationNote ?? '',
      expiresAt: o.expiresAt ? o.expiresAt.slice(0, 10) : '',
    });
    setWizardOpen(true);
  };

  const hiredStage = stages.find((s) => s.key === DEFAULT_HIRED_STAGE_KEY);
  const showSuggestion =
    !suggestionDismissed &&
    !!hiredStage &&
    pipelineStatus !== DEFAULT_HIRED_STAGE_KEY &&
    offers.some((o) => o.status === 'ACCEPTED');

  const moveStage = async () => {
    if (!hiredStage) return;
    setMovingStage(true);
    try {
      await onMoveToStage(hiredStage.key);
      setSuggestionDismissed(true);
    } finally {
      setMovingStage(false);
    }
  };

  return (
    <Card data-testid="offer-management-panel">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>{t.offers.title}</CardTitle>
        <Button
          size="sm"
          data-testid="offer-create-button"
          onClick={() => {
            setEditing(null);
            setWizardOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t.offers.create}
        </Button>
      </CardHeader>

      {showSuggestion && hiredStage && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800 p-3">
          <p className="text-sm text-green-800 dark:text-green-200">
            {t.offers.suggestStage.replace('{stage}', hiredStage.label)}
          </p>
          <div className="flex gap-2 flex-shrink-0">
            <Button size="sm" loading={movingStage} onClick={moveStage} data-testid="offer-move-stage-button">
              <ArrowRight className="h-4 w-4 mr-1" />
              {t.offers.suggestStageMove}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSuggestionDismissed(true)}>
              {t.offers.suggestStageDismiss}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400 py-4 text-center">{t.common.loading}</p>
      ) : offers.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">{t.offers.none}</p>
      ) : (
        <div className="space-y-3">
          {offers.map((o) => (
            <div key={o.id} data-testid={`offer-row-${o.id}`} className="rounded-lg border border-gray-100 dark:border-gray-700 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{o.position}</p>
                    <Badge variant={STATUS_VARIANT[o.status] ?? 'default'} data-testid={`offer-status-${o.id}`}>
                      {(t.offers.status as Record<string, string>)[o.status] ?? o.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {o.startDate && `${t.offers.wizard.startDate}: ${formatDate(o.startDate, locale)} · `}
                    {o.expiresAt && `${t.offers.wizard.expiresAt}: ${formatDate(o.expiresAt, locale)}`}
                  </p>
                  {o.status === 'DECLINED' && o.declineReasonCode && (
                    <p className="text-xs text-red-600 mt-1">
                      {t.offers.declineReason}: {(t.offerDeclineReasons as Record<string, string>)[o.declineReasonCode] ?? o.declineReasonCode}
                      {o.declineNote ? ` — ${o.declineNote}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {o.status === 'DRAFT' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => openEdit(o)}>
                        {t.offers.actions.edit}
                      </Button>
                      <Button size="sm" loading={busyId === o.id} onClick={() => setConfirm({ id: o.id, action: 'send' })}>
                        {t.offers.actions.send}
                      </Button>
                    </>
                  )}
                  {o.status === 'SENT' && (
                    <Button size="sm" variant="outline" loading={busyId === o.id} onClick={() => setConfirm({ id: o.id, action: 'withdraw' })}>
                      {t.offers.actions.withdraw}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => toggleHistory(o.id)}>
                    <History className="h-4 w-4 mr-1" />
                    {historyOpenId === o.id ? t.offers.actions.hideHistory : t.offers.actions.viewHistory}
                    {historyOpenId === o.id ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
                  </Button>
                </div>
              </div>

              {historyOpenId === o.id && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700" data-testid={`offer-history-${o.id}`}>
                  {(historyById[o.id]?.length ?? 0) === 0 ? (
                    <p className="text-xs text-gray-400">{t.offers.historyEmpty}</p>
                  ) : (
                    <ol className="space-y-1.5">
                      {historyById[o.id].map((h) => (
                        <li key={h.id} className="text-xs text-gray-500 flex items-center gap-2">
                          <span className="font-medium text-gray-700 dark:text-gray-300">
                            {(t.offers.timeline as Record<string, string>)[h.action] ?? h.action}
                          </span>
                          <span>· {formatDate(h.createdAt, locale)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <OfferWizardModal
        open={wizardOpen}
        relationId={relationId}
        menteeName={menteeName}
        companyName={companyName}
        existing={editing}
        onClose={() => setWizardOpen(false)}
        onSaved={load}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.action === 'send' ? t.offers.confirmSendTitle : t.offers.confirmWithdrawTitle}
        message={confirm?.action === 'send' ? t.offers.confirmSend : t.offers.confirmWithdraw}
        confirmLabel={confirm?.action === 'send' ? t.offers.actions.send : t.offers.actions.withdraw}
        cancelLabel={t.offers.wizard.cancel}
        variant={confirm?.action === 'withdraw' ? 'danger' : 'default'}
        loading={busyId === confirm?.id}
        onConfirm={() => confirm && runAction(confirm.id, confirm.action)}
        onCancel={() => setConfirm(null)}
      />
    </Card>
  );
}
