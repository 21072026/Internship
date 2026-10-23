'use client';

import dynamic from 'next/dynamic';
import { Circle, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import {
  FEEDBACK_REPLAY_MAX_BYTES,
  formatReplayDuration,
  formatReplaySize,
  replayDurationMs,
  type ReplayEvent,
} from '@/lib/feedbackReplayRule';

// The recording part of the feedback panel (#3131): attach the rolling window
// or a recording the person made themselves, and PREVIEW exactly what would be
// sent. State lives in FeedbackWidget; this only renders it. The player (and
// rrweb-player's stylesheet) loads only when a preview is opened.

const ReplayView = dynamic(() => import('@/components/ReplayView'), { ssr: false });

/** A recording frozen for preview and sending: what is shown is what is sent. */
export interface FrozenReplay {
  kind: 'window' | 'manual';
  events: ReplayEvent[];
  blob: Blob;
}

export function FeedbackReplaySection({
  seconds,
  attach,
  onAttachChange,
  frozen,
  previewing,
  previewFailed,
  onPreviewToggle,
  onPreviewFailed,
  onStartRecording,
  onDiscard,
  notice,
  busy,
}: {
  seconds: number;
  attach: boolean;
  onAttachChange: (v: boolean) => void;
  frozen: FrozenReplay | null;
  previewing: boolean;
  previewFailed: boolean;
  onPreviewToggle: () => void;
  onPreviewFailed: () => void;
  onStartRecording: () => void;
  onDiscard: () => void;
  notice: string;
  busy: boolean;
}) {
  const t = useT();
  const f = t.feedback;
  const locale = useLocale();
  const manual = frozen?.kind === 'manual';
  const tooLarge = !!frozen && frozen.blob.size > FEEDBACK_REPLAY_MAX_BYTES;
  const meta = frozen
    ? f.manualMeta
        .replace('{duration}', formatReplayDuration(replayDurationMs(frozen.events)))
        .replace('{size}', formatReplaySize(frozen.blob.size, locale))
    : '';

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="feedback-replay-section">
      <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
        <input type="checkbox" className="mt-0.5" checked={attach} onChange={(e) => onAttachChange(e.target.checked)} data-testid="feedback-replay" />
        <span>
          {manual ? f.manualLabel : f.replayLabel.replace('{seconds}', String(seconds))}
          {meta && <span className="ml-1 text-gray-600 dark:text-gray-400" data-testid="feedback-replay-meta">({meta})</span>}
        </span>
      </label>
      <p className="ml-6 text-xs text-gray-600 dark:text-gray-400">{f.replayHint}</p>
      {notice && <p role="status" className="ml-6 text-xs text-amber-800 dark:text-amber-300">{notice}</p>}
      {tooLarge && (
        <p role="alert" className="ml-6 text-xs text-red-700 dark:text-red-400" data-testid="feedback-replay-too-large">
          {f.replayTooLarge
            .replace('{size}', formatReplaySize(frozen!.blob.size, locale))
            .replace('{max}', formatReplaySize(FEEDBACK_REPLAY_MAX_BYTES, locale))}
        </p>
      )}

      <div className="ml-6 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onPreviewToggle} disabled={busy} data-testid="feedback-replay-preview">
          {previewing ? <EyeOff className="mr-1 h-4 w-4" aria-hidden="true" /> : <Eye className="mr-1 h-4 w-4" aria-hidden="true" />}
          {previewing ? f.replayHidePreview : f.replayPreview}
        </Button>
        {manual ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy} data-testid="feedback-replay-discard">
            <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> {f.manualDiscard}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onStartRecording} disabled={busy} data-testid="feedback-record-start">
            <Circle className="mr-1 h-4 w-4 fill-red-600 text-red-600" aria-hidden="true" /> {f.replayStart}
          </Button>
        )}
      </div>
      {!manual && <p className="ml-6 text-xs text-gray-600 dark:text-gray-400">{f.replayStartHint}</p>}

      {previewing && frozen && (
        <div className="pt-1" data-testid="feedback-replay-player">
          {previewFailed ? (
            <p className="text-xs text-red-700 dark:text-red-400">{f.replayPreviewFailed}</p>
          ) : (
            <ReplayView events={frozen.events} maxWidth={400} onFailed={onPreviewFailed} />
          )}
        </div>
      )}
    </div>
  );
}
