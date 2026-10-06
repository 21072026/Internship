'use client';

import { useState } from 'react';
import { RefreshCw, Share2 } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The line under a kept AI result (#2044): when it was generated, whether this
// answer came from the saved copy, an explicit Regenerate, and — for the
// person it is about — sharing it with their mentor and taking it back.
// Visibility is changed server-side (PATCH /api/ai/artifacts/[id]), which is
// also where who-may-read is decided.

export interface ArtifactInfo {
  id: string;
  createdAt: string;
  visibility: string;
}

export function ArtifactMeta({
  artifact,
  cached,
  onRegenerate,
  regenerating,
  canShare,
}: {
  artifact: ArtifactInfo;
  cached?: boolean;
  onRegenerate?: () => void;
  regenerating?: boolean;
  canShare?: boolean;
}) {
  const t = useT();
  const a = t.aiArtifact;
  const s = t.portal.aiShare;
  const locale = useLocale();
  const [visibility, setVisibility] = useState(artifact.visibility);
  const [busy, setBusy] = useState(false);
  const shared = visibility !== 'PRIVATE';

  const toggleShare = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/artifacts/${encodeURIComponent(artifact.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: shared ? 'PRIVATE' : 'SHARED_WITH_MENTOR' }),
      });
      if (res.ok) setVisibility((await res.json()).artifact.visibility);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid="ai-artifact-meta">
      <span data-testid="ai-artifact-generated">{a.generatedAt.replace('{date}', formatDateTime(artifact.createdAt, locale))}</span>
      {cached && <span data-testid="ai-artifact-cached">{a.savedCopy}</span>}
      {onRegenerate && (
        <button type="button" onClick={onRegenerate} disabled={regenerating} data-testid="ai-artifact-regenerate" className="inline-flex items-center gap-1 text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300">
          <RefreshCw className="h-3 w-3" /> {a.regenerate}
        </button>
      )}
      {canShare && (
        <button type="button" onClick={toggleShare} disabled={busy} aria-pressed={shared} data-testid="ai-artifact-share" className="inline-flex items-center gap-1 text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300">
          <Share2 className="h-3 w-3" /> {shared ? `${s.shared} · ${s.unshare}` : s.share}
        </button>
      )}
    </div>
  );
}
