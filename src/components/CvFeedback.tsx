'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AiBadge } from '@/components/AiBadge';
import { AiText } from '@/components/ai/AiText';
import { useT } from '@/i18n/client';
import { ArtifactMeta, type ArtifactInfo } from '@/components/ai/ArtifactMeta';
import { CvReviewView } from '@/components/ai/CvReviewView';
import { readStoredFeedback, type StoredCvFeedback } from '@/lib/cvReviewRules';

// AI CV feedback for the mentee (Faz 2, #535), scored since #2050. Free for
// the mentee — every denial (no consent, quota, provider down, AI off) shows a
// neutral "temporarily unavailable", never a paywall or an upgrade prompt.
// Hidden without an uploaded CV; without a provider it still shows the last
// stored review (reading it costs nothing) and no button. Without consent it
// renders a hint linking to the consent settings.
export function CvFeedback() {
  const t = useT();
  const c = t.cvFeedback;
  const [state, setState] = useState<{ configured: boolean; hasCv: boolean; consent: boolean; roles?: { id: string; title: string; company: string }[] } | null>(null);
  const [feedback, setFeedback] = useState<StoredCvFeedback | null>(null);
  const [previousScore, setPreviousScore] = useState<number | null>(null);
  const [roleId, setRoleId] = useState('');
  // The kept feedback (#2044): shown on mount, with when it was written.
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [cached, setCached] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/cv/feedback')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setState(d);
        if (d?.latest) {
          setFeedback(readStoredFeedback(d.latest.content));
          setArtifact(d.latest);
          setPreviousScore(d.previousScore ?? null);
        }
      })
      .catch(() => {});
  }, []);

  if (!state || !state.hasCv || (!state.configured && !feedback)) return null;

  const run = async (regenerate = false) => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/cv/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(regenerate ? { regenerate: true } : {}), ...(roleId ? { requisitionId: roleId } : {}) }),
      });
      const body = await res.json();
      if (res.ok) {
        if (body.empty) setNotice(c.empty);
        else {
          setFeedback({ kind: 'review', review: body.review });
          setPreviousScore(body.previousScore ?? null);
          setArtifact(body.artifact ?? null);
          setCached(!!body.cached);
        }
      } else if (body.code === 'consent_required') {
        setNotice(c.consentRequired);
      } else if (body.code === 'disabled') {
        // Switched off by the organisation (#2032): said as such.
        setNotice(c.aiOff);
      } else {
        // quota_exceeded / not_configured / anything else: neutral message —
        // the mentee never sees pricing or quota mechanics.
        setNotice(c.unavailable);
      }
    } catch {
      setNotice(c.unavailable);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-800 p-4" data-testid="cv-feedback">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.title}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{c.hint}</p>
        </div>
        {!state.configured ? null : state.consent ? (
          <Button type="button" variant="outline" size="sm" loading={loading} onClick={() => run()}>
            <Sparkles className="h-4 w-4 mr-1" /> {c.button}
          </Button>
        ) : (
          <Link href="/account" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            {c.consentCta}
          </Link>
        )}
      </div>
      {state.configured && state.consent && (state.roles?.length ?? 0) > 0 && (
        <label className="mt-3 block text-xs text-gray-700 dark:text-gray-300">
          <span className="mb-1 block font-medium">{c.tailorTo}</span>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 sm:w-auto"
            data-testid="cv-feedback-role"
          >
            <option value="">{c.generalReview}</option>
            {state.roles!.map((r) => (
              <option key={r.id} value={r.id}>{r.title} · {r.company}</option>
            ))}
          </select>
        </label>
      )}
      {notice && <p className="text-xs text-amber-600 dark:text-amber-400 mt-2" data-testid="cv-feedback-notice">{notice}</p>}
      {feedback && (
        <div className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900 p-3 text-sm text-gray-800 dark:text-gray-200">
          {/* Marked, because a mentee acting on advice about their own CV
              deserves to know a model wrote it (#2034). */}
          <AiBadge note className="mb-2" />
          {feedback.kind === 'review' ? <CvReviewView review={feedback.review} previousScore={previousScore} /> : <AiText text={feedback.text} testId="cv-feedback-text" />}
          {artifact && <ArtifactMeta key={artifact.id} artifact={artifact} cached={cached} onRegenerate={state.configured && state.consent ? () => run(true) : undefined} regenerating={loading} canShare />}
        </div>
      )}
    </div>
  );
}
