'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AiBadge } from '@/components/AiBadge';
import { useT } from '@/i18n/client';
import { ArtifactMeta, type ArtifactInfo } from '@/components/ai/ArtifactMeta';

// AI auto-summary of the interaction log (Faz 2, #534), mentor-facing. Runs
// on demand (never automatically — each run consumes AI quota) and surfaces
// the gate's denials as human messages: missing mentee consent, exhausted
// quota, or an unconfigured provider (in which case the button self-hides
// after the first attempt reveals it). The last summary is kept (#2044) and
// shown on mount with when it was made; an unchanged log is answered from that
// copy for free, and Regenerate asks the provider again on purpose.
export function InteractionSummary({ relationId }: { relationId: string }) {
  const t = useT();
  const a = t.aiSummary;
  const [summary, setSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [cached, setCached] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/interactions/summary?relationId=${encodeURIComponent(relationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!live || !body) return;
        // An admin on a pair that is not theirs, in an org without the AI
        // pack (#1738): one line, no button. The pair's own mentor never sees it.
        if (body.locked) {
          setLocked(true);
          return;
        }
        if (!body.latest) return;
        setSummary(body.latest.content);
        setArtifact(body.latest);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [relationId]);

  const run = async (regenerate = false) => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/interactions/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, regenerate }),
      });
      const body = await res.json();
      if (res.ok) {
        if (body.empty) setNotice(a.empty);
        else {
          setSummary(body.summary);
          setArtifact(body.artifact ?? null);
          setCached(!!body.cached);
        }
      } else if (body.code === 'feature_locked') {
        setLocked(true);
      } else if (body.code === 'consent_required') {
        setNotice(a.consentRequired);
      } else if (body.code === 'quota_exceeded') {
        setNotice(a.quotaExceeded);
      } else if (body.code === 'provider_error') {
        setNotice(a.providerError);
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
  if (locked) {
    return (
      <div className="mb-4" data-testid="interaction-summary">
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="interaction-summary-locked">{a.locked}</p>
      </div>
    );
  }

  return (
    <div className="mb-4" data-testid="interaction-summary">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">{a.hint}</p>
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={() => run()}>
          <Sparkles className="h-4 w-4 mr-1" /> {a.button}
        </Button>
      </div>
      {notice && <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">{notice}</p>}
      {summary && (
        <div className="mt-3 rounded-lg border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/10 p-3 text-sm text-gray-800 dark:text-gray-200">
          {/* A summary of someone else's mentee is exactly the text a reader
              would otherwise take for the mentor's own words (#2034). */}
          <AiBadge note className="mb-2" />
          <div className="whitespace-pre-line">{summary}</div>
          {artifact && <ArtifactMeta key={artifact.id} artifact={artifact} cached={cached} onRegenerate={() => run(true)} regenerating={loading} />}
        </div>
      )}
    </div>
  );
}
