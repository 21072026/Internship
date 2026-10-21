'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';

// Create a survey from a built-in instrument (#1877). The wording is resolved
// on the server (src/lib/surveyTemplateInput.ts); this form only picks the
// instrument, who answers it and how private it is. "Open and send now" is the
// two existing writes in a row — the survey opens, and a MANUAL campaign
// (#1887) invites the audience on the next dispatch tick.

export interface Instrument {
  key: string;
  title: string;
  description: string;
  questions: number;
  audiences: ('MENTEE' | 'MENTOR' | 'BOTH')[];
  anonymityDefault: 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS';
}

const ANONYMITIES = ['IDENTIFIED', 'CONFIDENTIAL', 'ANONYMOUS'] as const;

export function SurveyFromInstrument({ instruments, onCreated }: { instruments: Instrument[]; onCreated: () => void }) {
  const t = useT();
  const s = t.surveyResults;
  const [key, setKey] = useState(instruments[0]?.key ?? '');
  const instrument = instruments.find((i) => i.key === key);
  const [audience, setAudience] = useState<Instrument['audiences'][number]>('MENTEE');
  const [anonymity, setAnonymity] = useState<Instrument['anonymityDefault']>('CONFIDENTIAL');
  const [sendNow, setSendNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // A new instrument brings its own defaults.
  useEffect(() => {
    if (!instrument) return;
    setAudience(instrument.audiences[0]);
    setAnonymity(instrument.anonymityDefault);
  }, [instrument]);

  if (!instrument) return null;

  const audienceLabel = (a: Instrument['audiences'][number]) => (a === 'BOTH' ? s.audience_BOTH : s[`role_${a}`]);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateKey: key, audience, anonymity }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { survey } = await res.json();
      if (sendNow) {
        const opened = await fetch(`/api/admin/surveys/${survey.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'OPEN' }),
        });
        if (!opened.ok) throw new Error(String(opened.status));
        const campaign = await fetch('/api/admin/survey-campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surveyId: survey.id, name: instrument.title.slice(0, 120), trigger: 'MANUAL' }),
        });
        if (!campaign.ok) throw new Error(String(campaign.status));
      }
      setMessage({ ok: true, text: sendNow ? s.createdSent : s.createdDraft });
      onCreated();
    } catch {
      setMessage({ ok: false, text: t.common.error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6" data-testid="survey-create">
      <h2 className="mb-1 font-semibold text-gray-900 dark:text-gray-100">{s.createTitle}</h2>
      <p className="mb-4 text-sm text-gray-500">{s.createSubtitle}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <Select
          id="survey-create-instrument"
          label={s.createInstrument}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          options={instruments.map((i) => ({ value: i.key, label: i.title }))}
          data-testid="survey-create-instrument"
        />
        <Select
          id="survey-create-audience"
          label={s.createAudience}
          value={audience}
          onChange={(e) => setAudience(e.target.value as Instrument['audiences'][number])}
          options={instrument.audiences.map((a) => ({ value: a, label: audienceLabel(a) }))}
          data-testid="survey-create-audience"
        />
        <Select
          id="survey-create-anonymity"
          label={s.colAnonymity}
          value={anonymity}
          onChange={(e) => setAnonymity(e.target.value as Instrument['anonymityDefault'])}
          options={ANONYMITIES.map((a) => ({ value: a, label: s[`anonymity_${a}`] }))}
          data-testid="survey-create-anonymity"
        />
      </div>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-300" data-testid="survey-create-description">{instrument.description}</p>
      {!instrument.audiences.includes('BOTH') && instrument.audiences.length > 1 && (
        <p className="mt-1 text-xs text-gray-500">{s.createOnePerRole}</p>
      )}
      <label className="mt-4 flex min-h-[44px] items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} data-testid="survey-create-send-now" />
        {s.createSendNow}
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={submit} loading={busy} data-testid="survey-create-submit">
          <Plus className="mr-1 h-4 w-4" /> {s.createSubmit}
        </Button>
        {message && (
          <p className={message.ok ? 'text-sm text-green-700 dark:text-green-400' : 'text-sm text-red-600'} role={message.ok ? 'status' : 'alert'} data-testid="survey-create-message">
            {message.text}
          </p>
        )}
      </div>
    </Card>
  );
}
