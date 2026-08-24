'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

// EPIC B2 — per-user consent toggles (GDPR). Reusable: each entry gates an
// optional processing activity. menteeOnly entries only apply to (and only
// render for) MENTEE accounts — e.g. talent-pool visibility (#527); mentorOnly
// entries likewise only render for MENTOR accounts — e.g. the mentee-facing
// mentor directory (#937).
const CONSENTS = [
  { type: 'AI_CV_PARSING', key: 'aiCvParsing' as const },
  { type: 'ACTIVITY_TRACKING', key: 'activityTracking' as const },
  { type: 'TALENT_POOL_VISIBILITY', key: 'talentPoolVisibility' as const, menteeOnly: true },
  { type: 'AI_INTERACTION_SUMMARY', key: 'aiInteractionSummary' as const, menteeOnly: true },
  { type: 'MENTOR_DIRECTORY_VISIBILITY', key: 'mentorDirectoryVisibility' as const, mentorOnly: true },
  // Both roles (#1096): the author consents to their words being quoted, the
  // subject consents to a story about them existing at all.
  { type: 'TESTIMONIAL', key: 'testimonial' as const },
];

export function ConsentSettings() {
  const t = useT();
  const c = t.consent;
  const { data: session } = useSession();
  const visibleConsents = CONSENTS
    .filter((x) => !x.menteeOnly || session?.user?.role === 'MENTEE')
    .filter((x) => !x.mentorOnly || session?.user?.role === 'MENTOR');
  const [state, setState] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Name display on published testimonials (#1096): initials by default,
  // full name only as an explicit choice next to the consent itself.
  const [nameStyle, setNameStyle] = useState<'initials' | 'fullname'>('initials');

  useEffect(() => {
    fetch('/api/consent').then((r) => r.json()).then((d) => setState(d.consents ?? {})).catch(() => {});
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user?.testimonialNameStyle === 'fullname' && setNameStyle('fullname'))
      .catch(() => {});
  }, []);

  const saveNameStyle = async (style: 'initials' | 'fullname') => {
    setNameStyle(style);
    try {
      await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testimonialNameStyle: style }),
      });
    } catch {
      // Best-effort — the server default (initials) is the safe fallback.
    }
  };

  const toggle = async (type: string, granted: boolean) => {
    setBusy(type);
    setState((s) => ({ ...s, [type]: granted })); // optimistic
    try {
      const res = await fetch('/api/consent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, granted }),
      });
      const d = await res.json();
      if (res.ok) setState(d.consents ?? {});
    } catch {
      setState((s) => ({ ...s, [type]: !granted })); // revert
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mt-6 max-w-4xl">
      <CardHeader><CardTitle>{c.section}</CardTitle></CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 text-gray-400 flex-shrink-0" />
        {c.intro}
      </p>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {visibleConsents.map(({ type, key }) => {
          const item = (c.items as Record<string, { title: string; desc: string }>)[key];
          return (
            <div key={type}>
              <label className="flex items-start justify-between gap-4 py-3 cursor-pointer">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{item.desc}</p>
                </div>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0"
                  checked={!!state[type]}
                  disabled={busy === type}
                  onChange={(e) => toggle(type, e.target.checked)}
                />
              </label>
              {type === 'TESTIMONIAL' && state[type] && (
                <div className="pb-3 pl-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <span>{c.nameStyleLabel}</span>
                  <select
                    value={nameStyle}
                    onChange={(e) => saveNameStyle(e.target.value as 'initials' | 'fullname')}
                    data-testid="testimonial-name-style"
                    className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-xs"
                  >
                    <option value="initials">{c.nameStyleInitials}</option>
                    <option value="fullname">{c.nameStyleFullname}</option>
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
