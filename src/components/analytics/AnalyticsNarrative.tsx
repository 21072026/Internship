'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { AiBadge } from '@/components/AiBadge';
import { ArtifactMeta, type ArtifactInfo } from '@/components/ai/ArtifactMeta';
import { useT } from '@/i18n/client';

// "What changed" on /admin/analytics (#2046): a paragraph written from the
// figures on this page and kept only if every number it cites is one of them.
// On load it shows the stored paragraph for the current range, if any (GET —
// no provider call); writing one is an explicit click. With AI off the card
// is not drawn at all: the figures around it are complete without it.

interface Body {
  narrative: string | null;
  cached: boolean;
  artifact: ArtifactInfo | null;
  reason: string | null;
  configured: boolean;
}

export function AnalyticsNarrative({ query }: { query: string }) {
  const t = useT();
  const n = t.analyticsNarrative;
  const [body, setBody] = useState<Body | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBody(null);
    fetch(`/api/admin/analytics/narrative${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setBody(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [query]);

  const run = useCallback(async (regenerate = false) => {
    setBusy(true);
    try {
      const params = Object.fromEntries(new URLSearchParams(query.replace(/^\?/, '')));
      const res = await fetch('/api/admin/analytics/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, regenerate }),
      });
      if (res.ok) setBody(await res.json());
    } finally {
      setBusy(false);
    }
  }, [query]);

  if (!body || (!body.configured && !body.narrative)) return null;
  const reason = body.reason ? (n.reasons as Record<string, string>)[body.reason] ?? t.common.error : null;

  return (
    <Card className="mb-6 p-4" data-testid="analytics-narrative">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{n.title}</h2>
        <AiBadge note />
      </div>
      {body.narrative ? (
        <>
          <p className="mt-2 whitespace-pre-line text-sm text-gray-800 dark:text-gray-200" data-testid="analytics-narrative-text">{body.narrative}</p>
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{n.note}</p>
          {body.artifact && <ArtifactMeta key={body.artifact.id} artifact={body.artifact} cached={body.cached} onRegenerate={body.configured ? () => run(true) : undefined} regenerating={busy} />}
        </>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => run()} loading={busy} data-testid="analytics-narrative-write">
            <Sparkles className="mr-1 h-4 w-4" /> {n.write}
          </Button>
          <p className="text-xs text-gray-500 dark:text-gray-400">{n.hint}</p>
        </div>
      )}
      {reason && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300" data-testid="analytics-narrative-reason">{reason}</p>}
    </Card>
  );
}
