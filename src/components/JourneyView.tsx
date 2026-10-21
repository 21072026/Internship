'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Clock } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { stepTitle, type JourneySkipCondition, type ParticipantGroup } from '@/lib/programJourneyRule';

// The participant journey (#1855): one forward-looking list for the pair —
// what is due now, what comes next, what is done — read from GET /api/journey,
// which gives both seats the same dates. The onboarding checklist is its first
// milestone, so the pair never has two competing lists on one screen. The
// backward-looking record is RelationTimeline (#1700); this does not repeat it.
// Mobile-first: one column, wrapping text, no fixed widths (#1465 failed at 360px).

interface OnboardingItem { key: string; done: boolean; observed: boolean }
interface JourneyStep {
  id: string;
  milestone: string | null;
  action: string;
  audience: string;
  title: string;
  translations: Partial<Record<'en' | 'tr' | 'de', string>>;
  group: ParticipantGroup;
  status: string;
  dueAt: string | null;
  evidence: { condition: JourneySkipCondition; at: string | null } | null;
}
interface Item {
  id: string;
  milestone: string;
  title: string;
  meta: string[];
  done: boolean;
}

export function JourneyView({ relationId }: { relationId: string }) {
  const t = useT();
  const J = t.participantJourney;
  const A = t.programJourney;
  const locale = useLocale();
  const [data, setData] = useState<{ onboarding: OnboardingItem[]; steps: JourneyStep[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/journey?relationId=${encodeURIComponent(relationId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (live) setData(body); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [relationId]);

  // A failed read hides the card rather than showing an error in the middle of the page.
  if (failed) return null;

  const fmt = (iso: string) => new Date(iso).toLocaleDateString(intlLocaleFor(locale), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const onboardingLabels = t.menteeOnboarding.steps as Record<string, string>;
  const groups: Record<ParticipantGroup, Item[]> = { now: [], next: [], done: [] };

  for (const o of data?.onboarding ?? []) {
    groups[o.done ? 'done' : 'now'].push({
      id: `onboarding-${o.key}`,
      milestone: J.gettingStarted,
      title: onboardingLabels[o.key] ?? o.key,
      meta: o.done ? [o.observed ? J.observed : J.ticked] : [J.forWho.replace('{who}', A.audiences.MENTOR)],
      done: o.done,
    });
  }
  for (const s of data?.steps ?? []) {
    const meta: string[] = [A.actions[s.action as keyof typeof A.actions] ?? s.action];
    meta.push(J.forWho.replace('{who}', A.audiences[s.audience as keyof typeof A.audiences] ?? s.audience));
    if (s.evidence) {
      meta.push(s.evidence.at ? J.evidence[s.evidence.condition].replace('{date}', fmt(s.evidence.at)) : J.observed);
    } else if (s.status === 'waiting') {
      meta.push(J.waiting);
    } else if (s.dueAt) {
      meta.push((s.group === 'done' ? J.sentOn : J.dueOn).replace('{date}', fmt(s.dueAt)));
    }
    groups[s.group].push({ id: s.id, milestone: s.milestone ?? '', title: stepTitle(s, locale), meta, done: s.group === 'done' });
  }

  const section = (key: ParticipantGroup, label: string, empty?: string) => {
    const items = groups[key];
    if (items.length === 0 && !empty) return null;
    return (
      <section key={key} data-testid={`journey-group-${key}`} className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{label} ({items.length})</h3>
        {items.length === 0 ? (
          <p className="text-sm text-gray-400">{empty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((it, i) => (
              <li key={it.id} data-testid={`journey-item-${it.id}`} className="flex min-w-0 items-start gap-2">
                {it.done
                  ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  : key === 'now'
                    ? <Circle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                    : <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />}
                <div className="min-w-0 flex-1">
                  {it.milestone && (i === 0 || items[i - 1].milestone !== it.milestone) && (
                    <p className="text-xs uppercase tracking-wide text-gray-400 break-words">{it.milestone}</p>
                  )}
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">{it.title}</p>
                  <p className="text-xs text-gray-500 break-words">{it.meta.join(' · ')}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  const nothing = data && data.onboarding.length === 0 && data.steps.length === 0;
  return (
    <Card data-testid="journey-view">
      <CardHeader>
        <CardTitle>{J.title}</CardTitle>
      </CardHeader>
      <p className="mb-4 text-sm text-gray-500">{J.subtitle}</p>
      {!data ? (
        <SkeletonRows rows={3} />
      ) : nothing ? (
        <p className="text-sm text-gray-400">{J.empty}</p>
      ) : (
        <div className="space-y-5">
          {section('now', J.now, J.nothingNow)}
          {section('next', J.next)}
          {section('done', J.done)}
        </div>
      )}
    </Card>
  );
}
