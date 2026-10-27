'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkillRating } from '@/components/SkillRating';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';

interface SkillLevelRow {
  skillId: string;
  label: string;
  level: number | null;
  levelSource: string | null;
  verified: boolean;
}

// The mentee's skill levels on the mentor's mentee page (#1822): the
// self-assessment as it stands, and a Confirm per skill — optionally after
// correcting the stars. The route decides who may confirm; this panel only
// hides the button when the GET already said no (an ended pair).
export function MenteeSkillLevels({ relationId }: { relationId: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<SkillLevelRow[] | null>(null);
  const [canConfirm, setCanConfirm] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/mentorship/${relationId}/skills?locale=${locale}`);
    if (!res.ok) return setRows([]);
    const data = await res.json();
    setRows(data.skills ?? []);
    setCanConfirm(Boolean(data.canConfirm));
    setDraft({});
  }, [relationId, locale]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirm(row: SkillLevelRow) {
    const level = draft[row.skillId] ?? row.level ?? 0;
    if (!level) return toast(t.skillConfirm.pickLevel, 'error');
    setBusy(row.skillId);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/skills/${row.skillId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      if (res.status === 409) toast(t.skillConfirm.conflict, 'error');
      else if (res.ok) toast(t.skillConfirm.saved);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return null;
  return (
    <Card data-testid="mentee-skill-levels">
      <CardHeader>
        <CardTitle>{t.skillConfirm.title}</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t.skillConfirm.empty}</p>
      ) : (
        <>
          {canConfirm && <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t.skillConfirm.hint}</p>}
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map((row) => {
              const value = draft[row.skillId] ?? row.level ?? 0;
              return (
                <li key={row.skillId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`skill-level-${row.skillId}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {row.verified ? (
                        <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                          <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> {t.skillConfirm.confirmed}
                        </span>
                      ) : row.level ? (
                        t.skillConfirm.selfAssessed
                      ) : (
                        t.skillConfirm.notRated
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canConfirm ? (
                      <SkillRating
                        value={value}
                        label={row.label}
                        onChange={(v) => setDraft((d) => ({ ...d, [row.skillId]: v }))}
                      />
                    ) : (
                      row.level && <span className="text-sm text-gray-700 dark:text-gray-300">{row.level}/5</span>
                    )}
                    {canConfirm && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === row.skillId || !value || (row.verified && value === row.level)}
                        onClick={() => confirm(row)}
                        data-testid={`skill-confirm-${row.skillId}`}
                      >
                        {t.skillConfirm.confirm}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
