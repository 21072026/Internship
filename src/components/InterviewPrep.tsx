'use client';

import { useEffect, useState } from 'react';
import { GraduationCap, Sparkles } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// AI interview-prep card on the mentee portal (Faz 2, #536). Free for the
// mentee (quota problems surface as a neutral "unavailable", never a paywall).
// Hides itself entirely when the provider isn't configured.
export function InterviewPrep({ defaultPosition }: { defaultPosition?: string | null }) {
  const t = useT();
  const c = t.interviewPrep;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [position, setPosition] = useState(defaultPosition ?? '');
  const [focus, setFocus] = useState('');
  const [prep, setPrep] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/interview-prep')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setConfigured(!!d?.configured))
      .catch(() => setConfigured(false));
  }, []);

  if (!configured) return null;

  const run = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/interview-prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: position.trim() || undefined, focus: focus.trim() || undefined }),
      });
      const body = await res.json();
      if (res.ok) setPrep(body.prep);
      else if (body.code === 'no_position') setNotice(c.noPosition);
      else setNotice(c.unavailable);
    } catch {
      setNotice(c.unavailable);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mt-6" data-testid="interview-prep">
      <CardHeader>
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5 text-blue-600" />
          <CardTitle>{c.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{c.hint}</p>
      <div className="flex flex-col sm:flex-row gap-2 mb-2">
        <input
          type="text"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          placeholder={c.positionPlaceholder}
          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder={c.focusPlaceholder}
          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <Button type="button" size="sm" loading={loading} onClick={run}>
          <Sparkles className="h-4 w-4 mr-1" /> {c.button}
        </Button>
      </div>
      {notice && <p className="text-xs text-amber-600 dark:text-amber-400">{notice}</p>}
      {prep && (
        <div className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900 p-4 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line">
          {prep}
        </div>
      )}
    </Card>
  );
}
