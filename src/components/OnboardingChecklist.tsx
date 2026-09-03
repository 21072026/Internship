'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, X, Rocket, HelpCircle } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Step { key: string; done: boolean; href: string; optional?: boolean; guideKey?: string }

// Role-aware first-run checklist shown on the dashboard. Hides itself when all
// required steps are done or the user dismisses it.
//
// Dismissal lives on the SERVER (UserGuidanceState, keyed `checklist:<ROLE>`),
// so closing the card on one laptop keeps it closed after signing in on the
// next one — and anyone helping a programme owner can see where they are.
// `done` deliberately stays derived from real rows by the API; nothing here
// records "I clicked it".
export function OnboardingChecklist() {
  const t = useT();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [role, setRole] = useState('');
  const [dismissed, setDismissed] = useState(true);
  const [openGuide, setOpenGuide] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((d) => {
        setSteps(d.steps ?? []);
        setRole(d.role ?? '');
        // The server is the source of truth. The localStorage read stays as an
        // optimistic default so a browser that dismissed the card before this
        // shipped — or while the write failed offline — keeps it closed; it can
        // only ever hide the card, never re-open one the server closed.
        const locallyDismissed = localStorage.getItem(`onboarding-dismissed-${d.role}`) === '1';
        setDismissed(Boolean(d.dismissed) || locallyDismissed);
      })
      .catch(() => setSteps([]));
  }, []);

  if (!steps || steps.length === 0 || dismissed) return null;
  // Only required steps decide completion — an optional step (e.g. the mentor's
  // "schedule a meeting") must never keep the checklist open forever.
  const allDone = steps.filter((s) => !s.optional).every((s) => s.done);
  if (allDone) return null;

  const labels = t.checklist.steps as Record<string, string>;
  const guides = t.checklist.guides as Record<string, string>;
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);
  const dismiss = () => {
    localStorage.setItem(`onboarding-dismissed-${role}`, '1');
    setDismissed(true);
    // Fire-and-forget: the card is already gone locally, and the localStorage
    // fallback above covers the request that never lands.
    fetch('/api/onboarding/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    }).catch(() => {});
  };

  return (
    <div className="mb-6 rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/40 p-5" data-testid="onboarding-checklist">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">{t.checklist.title}</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">{doneCount}/{steps.length}</span>
        </div>
        <button onClick={dismiss} aria-label={t.checklist.dismiss} className="inline-flex min-h-11 min-w-11 items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-1.5 bg-blue-100 dark:bg-blue-900/60 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-3 space-y-1.5">
        {steps.map((s) => {
          const guideKey = s.guideKey ?? s.key;
          const guide = guides[guideKey];
          const guideOpen = openGuide === s.key;
          return (
            <li key={s.key}>
              <div className="flex items-center gap-1">
                <Link
                  href={s.href}
                  data-testid={`onboarding-step-${s.key}`}
                  className={`flex min-h-11 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-white dark:hover:bg-gray-800 ${
                    // No `dark:` variant on the done branch: globals.css's flat
                    // `html.dark .text-gray-600` (0,2,1) outranks Tailwind's
                    // `.dark .text-gray-300` (0,2,0), so the variant would be dead
                    // code. The override already renders the dimmer #9ca3af that
                    // the completed state wants, and it clears AA on the dark box.
                    s.done ? 'text-gray-600' : 'text-gray-800 dark:text-gray-200'
                  }`}
                >
                  {s.done ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                  ) : (
                    <Circle className="h-4 w-4 text-gray-300 dark:text-gray-600 flex-shrink-0" />
                  )}
                  <span className={s.done ? 'line-through' : ''}>{labels[s.key] ?? s.key}</span>
                  {s.optional && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">({t.checklist.optional})</span>
                  )}
                </Link>
                {guide && (
                  <button
                    type="button"
                    onClick={() => setOpenGuide(guideOpen ? null : s.key)}
                    aria-expanded={guideOpen}
                    aria-controls={`onboarding-guide-${s.key}`}
                    aria-label={`${t.checklist.whyThisMatters} — ${labels[s.key] ?? s.key}`}
                    data-testid={`onboarding-guide-toggle-${s.key}`}
                    className="inline-flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-blue-700 dark:hover:text-blue-300"
                  >
                    <HelpCircle className="h-4 w-4" />
                  </button>
                )}
              </div>
              {guide && guideOpen && (
                <p
                  id={`onboarding-guide-${s.key}`}
                  data-testid={`onboarding-guide-${s.key}`}
                  // Same specificity trap as above: `text-gray-700` already has
                  // a flat dark override in globals.css, so no `dark:` variant.
                  className="mx-2 mb-1 mt-0.5 rounded-lg bg-white/70 dark:bg-gray-900/50 px-3 py-2 text-xs leading-relaxed text-gray-700"
                >
                  {guide}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
