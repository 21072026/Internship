'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { useVertical } from '@/lib/verticalClient';

// One line on the stage-automation page (#3746): the first-contact auto-advance
// is a FIXED rule outside this engine (docs/automation-rules.md), so it is not a
// rule in the list below — this line says whether it is on and where it lives.
export function FirstContactAdvanceNote() {
  const t = useT();
  const n = t.automations.firstContactNote;
  const vertical = useVertical();
  const [mode, setMode] = useState<'on' | 'off' | null>(null);

  useEffect(() => {
    if (vertical !== 'MARKETING') return;
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMode(d?.settings?.firstContactAutoAdvance === 'on' ? 'on' : 'off'))
      .catch(() => {});
  }, [vertical]);

  if (vertical !== 'MARKETING' || mode === null) return null;
  return (
    <p className="mt-3 text-sm text-gray-600 dark:text-gray-400" data-testid="first-contact-advance-note" data-mode={mode}>
      {n.label}: <strong>{mode === 'on' ? n.on : n.off}</strong>{' '}
      <Link href="/admin/settings#first-contact-advance" className="text-blue-600 hover:underline dark:text-blue-400">
        → {n.settingsLink}
      </Link>
    </p>
  );
}
