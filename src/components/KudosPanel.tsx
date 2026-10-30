'use client';

import { useCallback, useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { interpolate } from '@/lib/notificationText';
import { KUDO_PRESETS, type KudoPreset } from '@/lib/kudosRule';
import { TEXT_LIMITS } from '@/lib/textLimits';

export interface KudoView {
  id: string;
  reason: string;
  createdAt: string;
  sender: { id: string; fullName: string };
  recipient: { id: string; fullName: string };
}

// Kudos on a pairing (#1868): a written, attributed thank-you, both directions,
// read by the pair and admins. No counts, no points — a list of sentences.
// A preset only pre-fills the box; what is sent is what the sender wrote.
export function KudosPanel({
  relationId,
  recipient,
  readOnly = false,
}: {
  relationId: string;
  recipient: { id: string; fullName: string } | null;
  readOnly?: boolean;
}) {
  const t = useT();
  const k = t.kudos;
  const toast = useToast();
  const [kudos, setKudos] = useState<KudoView[]>([]);
  const [reason, setReason] = useState('');
  const [preset, setPreset] = useState<KudoPreset | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/kudos?relationId=${relationId}`);
    if (res.ok) setKudos((await res.json()).kudos ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const pick = (p: KudoPreset) => {
    setPreset(p);
    setReason(k.presets[p]);
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipient || !reason.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/kudos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, recipientId: recipient.id, reason, presetKey: preset }),
      });
      if (!res.ok) {
        toast(k.failed, 'error');
        return;
      }
      setReason('');
      setPreset(null);
      toast(k.sent);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="kudos-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-500" aria-hidden />
          {k.title}
        </CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{k.hint}</p>

      {!readOnly && recipient && (
        <form onSubmit={send} className="space-y-2 mb-4" data-testid="kudos-form">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={k.presetsLabel}>
            {KUDO_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pick(p)}
                aria-pressed={preset === p}
                data-testid={`kudo-preset-${p}`}
                className={`rounded-full border px-2.5 py-1 text-xs ${preset === p ? 'border-rose-400 bg-rose-100 text-rose-800' : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              >
                {k.presets[p]}
              </button>
            ))}
          </div>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={TEXT_LIMITS.kudoReason}
            rows={2}
            placeholder={interpolate(k.placeholder, { name: recipient.fullName })}
            aria-label={interpolate(k.placeholder, { name: recipient.fullName })}
            data-testid="kudo-reason"
          />
          <Button type="submit" size="sm" loading={saving} disabled={!reason.trim()} data-testid="kudo-send">
            {k.send}
          </Button>
        </form>
      )}

      {kudos.length === 0 ? (
        <p className="text-sm text-gray-400" data-testid="kudos-empty">{k.none}</p>
      ) : (
        <ul className="space-y-3" data-testid="kudos-list">
          {kudos.map((kudo) => (
            <li key={kudo.id} className="border-l-2 border-rose-300 pl-3" data-testid={`kudo-${kudo.id}`}>
              <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{kudo.reason}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {fillTemplate(k.fromTo, { from: kudo.sender.fullName, to: kudo.recipient.fullName })} ·{' '}
                <RelativeTime date={kudo.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// The kudos the signed-in person has received, on their own account page.
// Renders nothing until there is one — no empty "0 kudos" scoreboard.
export function KudosReceived() {
  const t = useT();
  const k = t.kudos;
  const [kudos, setKudos] = useState<KudoView[]>([]);
  useEffect(() => {
    fetch('/api/kudos')
      .then((r) => (r.ok ? r.json() : { kudos: [] }))
      .then((d) => setKudos(d.kudos ?? []))
      .catch(() => {});
  }, []);
  if (kudos.length === 0) return null;
  return (
    <Card className="mt-6 max-w-4xl" data-testid="kudos-received">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-500" aria-hidden />
          {k.receivedTitle}
        </CardTitle>
      </CardHeader>
      <ul className="space-y-3">
        {kudos.map((kudo) => (
          <li key={kudo.id} className="border-l-2 border-rose-300 pl-3">
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{kudo.reason}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {fillTemplate(k.from, { from: kudo.sender.fullName })} · <RelativeTime date={kudo.createdAt} />
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
