'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, X, Rocket } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Step { key: string; done: boolean; href: string }

// Role-aware first-run checklist shown on the dashboard. Hides itself when all
// steps are done or the user dismisses it (remembered per role in localStorage).
export function OnboardingChecklist() {
  const t = useT();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [role, setRole] = useState('');
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((d) => {
        setSteps(d.steps ?? []);
        setRole(d.role ?? '');
        setDismissed(localStorage.getItem(`onboarding-dismissed-${d.role}`) === '1');
      })
      .catch(() => setSteps([]));
  }, []);

  if (!steps || steps.length === 0 || dismissed) return null;
  const allDone = steps.every((s) => s.done);
  if (allDone) return null;

  const labels = t.checklist.steps as Record<string, string>;
  const dismiss = () => {
    localStorage.setItem(`onboarding-dismissed-${role}`, '1');
    setDismissed(true);
  };

  return (
    <div className="mb-6 rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-blue-600" />
          <h2 className="font-semibold text-gray-900">{t.checklist.title}</h2>
        </div>
        <button onClick={dismiss} aria-label={t.checklist.dismiss} className="text-gray-400 hover:text-gray-700">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="mt-3 space-y-1.5">
        {steps.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-white ${
                s.done ? 'text-gray-400' : 'text-gray-800'
              }`}
            >
              {s.done ? (
                <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
              ) : (
                <Circle className="h-4 w-4 text-gray-300 flex-shrink-0" />
              )}
              <span className={s.done ? 'line-through' : ''}>{labels[s.key] ?? s.key}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
