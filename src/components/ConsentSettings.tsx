'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

// EPIC B2 — per-user consent toggles (GDPR). Reusable: each entry gates an
// optional processing activity. Currently: AI-assisted CV parsing.
const CONSENTS = [
  { type: 'AI_CV_PARSING', key: 'aiCvParsing' as const },
  { type: 'ACTIVITY_TRACKING', key: 'activityTracking' as const },
];

export function ConsentSettings() {
  const t = useT();
  const c = t.consent;
  const [state, setState] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/consent').then((r) => r.json()).then((d) => setState(d.consents ?? {})).catch(() => {});
  }, []);

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
        {CONSENTS.map(({ type, key }) => {
          const item = (c.items as Record<string, { title: string; desc: string }>)[key];
          return (
            <label key={type} className="flex items-start justify-between gap-4 py-3 cursor-pointer">
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
          );
        })}
      </div>
    </Card>
  );
}
