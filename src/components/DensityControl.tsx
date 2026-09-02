'use client';

import { useEffect, useState } from 'react';
import { Rows2, Rows3 } from 'lucide-react';
import { useT } from '@/i18n/client';
import { applyDensity, readStoredDensity, type Density } from '@/lib/density';

// Comfortable/compact spacing toggle (#2078). Persists to localStorage + a
// cookie (SSR + no-flash script agree) and, when signed in, to the account —
// same pattern as ThemeToggle and FontSizeControl.
export function DensityControl() {
  const t = useT();
  const [density, setDensity] = useState<Density>('comfortable');

  useEffect(() => {
    setDensity(readStoredDensity());
  }, []);

  const apply = (next: Density) => {
    setDensity(next);
    applyDensity(next);
    // Best-effort persist to the account (ignored / 401 when signed out).
    fetch('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ density: next }),
    }).catch(() => {});
  };

  const next: Density = density === 'compact' ? 'comfortable' : 'compact';
  const label: Record<Density, string> = { comfortable: t.density.comfortable, compact: t.density.compact };
  const Icon = density === 'compact' ? Rows2 : Rows3;
  const ariaLabel = `${t.density.toggle}: ${label[density]} (${t.density.next}: ${label[next]})`;

  return (
    <button
      type="button"
      data-testid="density-control"
      data-density={density}
      onClick={() => apply(next)}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
    >
      <Icon className="h-4 w-4" />
      <span>{label[density]}</span>
    </button>
  );
}
