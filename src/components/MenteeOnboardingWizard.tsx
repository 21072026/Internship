'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronDown, Circle, Sparkles, X } from 'lucide-react';
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
//
// Layout: one card per mentee in a responsive grid (the cards used to be full
// width and stacked, which pushed the rest of the dashboard off-screen as soon
// as two mentees joined in the same week). Each card collapses to a single line
// — name, x/y progress, next step — and the open/closed state is remembered per
// mentee in localStorage.

interface Onboarding {
  menteeId: string;
  menteeName: string;
  relationId: string | null;
  projectId: string | null;
  steps: Record<OnboardingStep, { done: boolean; auto: boolean }>;
  remaining: number;
}

const COLLAPSE_KEY = 'mentee-onboarding-collapsed';

export function MenteeOnboardingWizard() {
  const t = useT();
  const [items, setItems] = useState<Onboarding[]>([]);
  const [busy, setBusy] = useState('');
  // menteeId → explicitly collapsed?, i.e. only the ones the mentor toggled.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const res = await fetch('/api/mentee-onboarding');
    if (!res.ok) return;
    const d = await res.json();
    setItems(d.onboardings ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) setCollapsed(JSON.parse(raw));
    } catch {
      // A corrupt entry just means "no preference yet".
    }
  }, []);

  const toggle = (menteeId: string, isOpen: boolean) => {
    setCollapsed((prev) => {
      const next = { ...prev, [menteeId]: isOpen };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // Private mode / full storage: the toggle still works for this visit.
      }
      return next;
    });
  };

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

  const total = ONBOARDING_STEPS.length;
  const stepLabels = t.menteeOnboarding.steps as Record<string, string>;

  return (
    <div className="mb-8" data-testid="mentee-onboarding-wizard">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-blue-500" />
        <h2 className="font-medium text-gray-900 dark:text-gray-100">{t.menteeOnboarding.title}</h2>
        <Badge variant="info">{items.length}</Badge>
        {/* One set of shared links for the whole block — repeating them on every
            card was most of what made the old full-width cards so tall. */}
        <div className="ml-auto flex flex-wrap gap-3 text-xs">
          <Link href="/mentor/mentees" className="text-blue-600 hover:underline">{t.nav.myMentees}</Link>
          <Link href="/mentor/meetings" className="text-blue-600 hover:underline">{t.nav.meetings}</Link>
        </div>
      </div>
      <div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {items.map((item, index) => {
          const done = total - item.remaining;
          const pct = Math.round((done / total) * 100);
          // Beyond the first two cards the block would start dominating the
          // dashboard again, so those open collapsed until told otherwise.
          const isCollapsed = collapsed[item.menteeId] ?? (items.length > 2 && index >= 2);
          const nextStep = ONBOARDING_STEPS.find((s) => !item.steps[s].done);
          const panelId = `onboarding-panel-${item.menteeId}`;

          return (
            <Card key={item.menteeId} padding="sm" data-testid={`onboarding-card-${item.menteeId}`}>
              <div className="flex items-center gap-2">
                {item.relationId ? (
                  <Link
                    href={`/mentor/mentees/${item.relationId}`}
                    className="min-w-0 truncate font-medium text-blue-600 hover:underline"
                    data-testid={`onboarding-mentee-link-${item.menteeId}`}
                  >
                    {item.menteeName}
                  </Link>
                ) : (
                  // Connected through a shared project only — there is no
                  // mentorship page to link to.
                  <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-200">{item.menteeName}</span>
                )}
                <Badge
                  variant={item.remaining === 0 ? 'success' : 'info'}
                  title={t.menteeOnboarding.remaining.replace('{n}', String(item.remaining))}
                  data-testid={`onboarding-progress-${item.menteeId}`}
                >
                  {done}/{total}
                </Badge>
                <button
                  type="button"
                  onClick={() => toggle(item.menteeId, !isCollapsed)}
                  aria-expanded={!isCollapsed}
                  aria-controls={panelId}
                  aria-label={isCollapsed ? t.menteeOnboarding.expand : t.menteeOnboarding.collapse}
                  title={isCollapsed ? t.menteeOnboarding.expand : t.menteeOnboarding.collapse}
                  className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  data-testid={`onboarding-toggle-${item.menteeId}`}
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} />
                </button>
                <button
                  type="button"
                  onClick={() => patch({ menteeId: item.menteeId, dismissed: true }, `dismiss-${item.menteeId}`)}
                  disabled={busy === `dismiss-${item.menteeId}`}
                  aria-label={t.menteeOnboarding.dismiss}
                  title={t.menteeOnboarding.dismiss}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  data-testid={`dismiss-onboarding-${item.menteeId}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
              </div>

              {isCollapsed ? (
                // The whole point of the collapsed state: one glance says how far
                // along this mentee is and what to do next.
                nextStep && (
                  <p className="mt-2 truncate text-xs text-gray-500" data-testid={`onboarding-next-${item.menteeId}`}>
                    {t.menteeOnboarding.next.replace('{step}', stepLabels[nextStep] ?? nextStep)}
                  </p>
                )
              ) : (
                <div id={panelId}>
                  {/* The name is the card's heading, so the sentence under it
                      does not repeat it. */}
                  <p className="mt-2 mb-3 text-sm text-gray-500">{t.menteeOnboarding.subtitle}</p>
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
                            aria-label={stepLabels[step]}
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
                            className="inline-flex min-h-11 min-w-11 items-center justify-center"
                          >
                            {state.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Circle className="h-4 w-4 text-gray-300" />}
                          </button>
                          <span className={state.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}>
                            {stepLabels[step]}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {item.projectId && (
                    <div className="mt-3 text-xs">
                      <Link href={`/projects/${item.projectId}`} className="text-blue-600 hover:underline">{t.nav.projects}</Link>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
