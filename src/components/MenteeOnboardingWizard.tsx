'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, Sparkles, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { ONBOARDING_STEPS, type OnboardingStep } from '@/lib/menteeOnboarding';

// The mentor's onboarding wizard (#51). It appears by itself when a mentee joins
// the site or one of the mentor's projects, and disappears once the checklist is
// done (or the mentor says "not now").
//
// Steps the app can observe — a first message, a booked meeting, project
// membership, assigned goals, a pipeline move — tick themselves, so the list
// reflects reality instead of asking the mentor to bookkeep.

interface Onboarding {
  menteeId: string;
  menteeName: string;
  relationId: string | null;
  projectId: string | null;
  steps: Record<OnboardingStep, { done: boolean; auto: boolean }>;
  remaining: number;
}

export function MenteeOnboardingWizard() {
  const t = useT();
  // The subtitle carries the mentee's name mid-sentence; split it so the name
  // itself can be a link to their mentorship page.
  const [subtitleBefore, subtitleAfter] = t.menteeOnboarding.subtitle.split('{name}');
  const [items, setItems] = useState<Onboarding[]>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/mentee-onboarding');
    if (!res.ok) return;
    const d = await res.json();
    setItems(d.onboardings ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      await fetch('/api/mentee-onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy('');
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="mb-8 space-y-3" data-testid="mentee-onboarding-wizard">
      {items.map((item) => (
        <Card key={item.menteeId}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-500" />
            <span className="font-medium text-gray-900 dark:text-gray-100">{t.menteeOnboarding.title}</span>
            <Badge variant="info">{t.menteeOnboarding.remaining.replace('{n}', String(item.remaining))}</Badge>
            <button
              type="button"
              onClick={() => patch({ menteeId: item.menteeId, dismissed: true }, `dismiss-${item.menteeId}`)}
              disabled={busy === `dismiss-${item.menteeId}`}
              className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
              data-testid={`dismiss-onboarding-${item.menteeId}`}
            >
              <X className="h-3.5 w-3.5" /> {t.menteeOnboarding.dismiss}
            </button>
          </div>
          <p className="mb-3 text-sm text-gray-500">
            {subtitleBefore}
            {item.relationId ? (
              <Link
                href={`/mentor/mentees/${item.relationId}`}
                className="font-medium text-blue-600 hover:underline"
                data-testid={`onboarding-mentee-link-${item.menteeId}`}
              >
                {item.menteeName}
              </Link>
            ) : (
              // Connected through a shared project only — there is no
              // mentorship page to link to.
              <span className="font-medium text-gray-700 dark:text-gray-200">{item.menteeName}</span>
            )}
            {subtitleAfter}
          </p>
          <ul className="space-y-1.5">
            {ONBOARDING_STEPS.map((step) => {
              const state = item.steps[step];
              const key = `${item.menteeId}-${step}`;
              return (
                <li key={step} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    // An observed step is a fact, not a checkbox: unticking it
                    // would be overwritten the moment the page reloads.
                    disabled={state.auto || busy === key}
                    onClick={() => patch({ menteeId: item.menteeId, step, done: !state.done }, key)}
                    aria-label={(t.menteeOnboarding.steps as Record<string, string>)[step]}
                    // Say which ticks are the app's own observation and which
                    // ones the mentor is expected to set.
                    title={
                      state.auto
                        ? t.menteeOnboarding.autoHint
                        : state.done
                        ? t.menteeOnboarding.unmarkHint
                        : t.menteeOnboarding.markHint
                    }
                    data-testid={`onboarding-step-${step}`}
                  >
                    {state.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Circle className="h-4 w-4 text-gray-300" />}
                  </button>
                  <span className={state.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}>
                    {(t.menteeOnboarding.steps as Record<string, string>)[step]}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <Link href="/mentor/mentees" className="text-blue-600 hover:underline">{t.nav.myMentees}</Link>
            <Link href="/mentor/meetings" className="text-blue-600 hover:underline">{t.nav.meetings}</Link>
            {item.projectId && (
              <Link href={`/projects/${item.projectId}`} className="text-blue-600 hover:underline">{t.nav.projects}</Link>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
