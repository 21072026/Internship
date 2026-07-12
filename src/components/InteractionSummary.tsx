'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// AI auto-summary of the interaction log (Faz 2, #534), mentor-facing. Runs
// on demand (never automatically — each run consumes AI quota) and surfaces
// the gate's denials as human messages: missing mentee consent, exhausted
// quota, or an unconfigured provider (in which case the button self-hides
// after the first attempt reveals it).
export function InteractionSummary({ relationId }: { relationId: string }) {
  const t = useT();
  const a = t.aiSummary;
  const [summary, setSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);

  const run = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/interactions/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId }),
      });
      const body = await res.json();
      if (res.ok) {
        if (body.empty) setNotice(a.empty);
        else setSummary(body.summary);
      } else if (body.code === 'consent_required') {
        setNotice(a.consentRequired);
      } else if (body.code === 'quota_exceeded') {
        setNotice(a.quotaExceeded);
      } else if (body.code === 'not_configured') {
        setHidden(true);
      } else {
        setNotice(t.common.error);
      }
    } catch {
      setNotice(t.common.error);
    } finally {
      setLoading(false);
    }
  };

  if (hidden) return null;

  return (
    <div className="mb-4" data-testid="interaction-summary">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">{a.hint}</p>
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={run}>
          <Sparkles className="h-4 w-4 mr-1" /> {a.button}
        </Button>
      </div>
      {notice && <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">{notice}</p>}
      {summary && (
        <div className="mt-3 rounded-lg border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/10 p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line">
          {summary}
        </div>
      )}
    </div>
  );
}
