'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { SCREENING_ITEMS, type ScreeningItem } from '@/lib/mentorScreeningRule';

// The org's screening policy (#1807): which checklist items must be done
// before an application may be approved. The server's approve handler is the
// enforcement; this card only edits the setting.
export function MentorScreeningPolicyCard({ onSaved }: { onSaved: (required: ScreeningItem[]) => void }) {
  const t = useT();
  const S = t.mentorApplicationsAdmin.screening;
  const toast = useToast();
  const [required, setRequired] = useState<ScreeningItem[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/mentor-applications/screening-policy')
      .then((r) => (r.ok ? r.json() : { required: [] }))
      .then((d) => setRequired(d.required ?? []))
      .catch(() => setRequired([]));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/mentor-applications/screening-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setRequired(d.required);
      onSaved(d.required);
      toast(S.policySaved);
    } catch {
      toast(S.saveError, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!required) return null;
  return (
    <Card className="mb-4" data-testid="mentor-screening-policy">
      <CardHeader><CardTitle>{S.policyTitle}</CardTitle></CardHeader>
      <p className="text-xs text-gray-500 mb-3">{S.policyHint}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {SCREENING_ITEMS.map((item) => (
          <label key={item} className="inline-flex items-center gap-1.5 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              checked={required.includes(item)}
              onChange={(e) => setRequired(e.target.checked ? [...required, item] : required.filter((i) => i !== item))}
              data-testid={`screening-policy-${item}`}
            />
            {S.items[item]}
          </label>
        ))}
      </div>
      <Button variant="outline" size="sm" className="mt-3" loading={saving} onClick={save} data-testid="screening-policy-save">
        {S.policySave}
      </Button>
    </Card>
  );
}
