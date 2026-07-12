'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// AI CV feedback for the mentee (Faz 2, #535). Free for the mentee — quota
// exhaustion shows a neutral "temporarily unavailable", never a paywall.
// Entirely hidden unless the provider is configured AND a CV is uploaded;
// without consent it renders a hint linking to the consent settings.
export function CvFeedback() {
  const t = useT();
  const c = t.cvFeedback;
  const [state, setState] = useState<{ configured: boolean; hasCv: boolean; consent: boolean } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/cv/feedback').then((r) => (r.ok ? r.json() : null)).then(setState).catch(() => {});
  }, []);

  if (!state || !state.configured || !state.hasCv) return null;

  const run = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/cv/feedback', { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        if (body.empty) setNotice(c.empty);
        else setFeedback(body.feedback);
      } else if (body.code === 'consent_required') {
        setNotice(c.consentRequired);
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
        {state.consent ? (
          <Button type="button" variant="outline" size="sm" loading={loading} onClick={run}>
            <Sparkles className="h-4 w-4 mr-1" /> {c.button}
          </Button>
        ) : (
          <Link href="/account" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            {c.consentCta}
          </Link>
        )}
      </div>
      {notice && <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">{notice}</p>}
      {feedback && (
        <div className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900 p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line">
          {feedback}
        </div>
      )}
    </div>
  );
}
