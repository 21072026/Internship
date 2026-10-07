'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { LOST_STAGE_KEY, type WinBackStage } from '@/lib/winBackRule';

// A lost customer came back (#2842, POST /api/mentorship/[id]/win-back). The
// lost journey closes as churned and a NEW one opens — so the button leads to
// the new record, never edits this one in place.
export function WinBackPanel({
  relationId,
  pipelineStatus,
  status,
  hrefFor,
}: {
  relationId: string;
  pipelineStatus: string;
  status: string;
  /** Where the new record opens. */
  hrefFor: (newRelationId: string) => string;
}) {
  const t = useT();
  const w = t.winBack;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (pipelineStatus !== LOST_STAGE_KEY || status !== 'ACTIVE') return null;

  const go = async (toStage: WinBackStage) => {
    if (!window.confirm(w.confirm)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/win-back`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStage }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data?.code === 'already_mentored' ? w.alreadyActive : w.error, 'error');
        router.refresh();
        return;
      }
      toast(w.done);
      router.push(hrefFor(data.relationId));
    } catch {
      toast(w.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-emerald-200 p-3 dark:border-emerald-800" data-testid="win-back-panel">
      <div className="mb-2 flex items-center gap-2">
        <RotateCcw className="h-4 w-4 text-emerald-600" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{w.title}</p>
      </div>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{w.hint}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" loading={busy} onClick={() => go('TRIAL_ACTIVE')} data-testid="win-back-trial">
          {w.toTrial}
        </Button>
        <Button size="sm" loading={busy} onClick={() => go('DEAL_WON')} data-testid="win-back-won">
          {w.toWon}
        </Button>
      </div>
    </div>
  );
}
