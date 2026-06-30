'use client';

import { useState } from 'react';
import { Phone, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Quick contact channels for a mentee's number. Opens tel:/wa.me, then asks the
// mentor whether they reached the mentee — a "yes" logs a Call/WhatsApp
// interaction so the contact history builds up automatically.
export function ContactActions({ relationId, phone, onLogged }: { relationId: string; phone: string; onLogged?: () => void }) {
  const t = useT();
  const digits = phone.replace(/[^\d+]/g, '');
  const wa = digits.replace(/^\+/, '');
  const [ask, setAsk] = useState<null | 'Call' | 'WhatsApp'>(null);
  const [saving, setSaving] = useState(false);

  const open = (channel: 'Call' | 'WhatsApp') => {
    const url = channel === 'Call' ? `tel:${digits}` : `https://wa.me/${wa}`;
    window.open(url, channel === 'Call' ? '_self' : '_blank');
    setAsk(channel);
  };

  const log = async (reached: boolean) => {
    const channel = ask;
    setAsk(null);
    if (!reached || !channel) return;
    setSaving(true);
    try {
      await fetch('/api/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relationId,
          date: new Date().toISOString(),
          type: channel,
          notes: channel === 'Call' ? t.contact.loggedCall : t.contact.loggedWhatsApp,
        }),
      });
      onLogged?.();
    } finally {
      setSaving(false);
    }
  };

  if (!digits) return null;

  return (
    <div className="inline-flex flex-col gap-2">
      <div className="inline-flex gap-2">
        <Button size="sm" variant="outline" onClick={() => open('Call')}>
          <Phone className="h-4 w-4 mr-1" />{t.contact.call}
        </Button>
        <Button size="sm" variant="outline" onClick={() => open('WhatsApp')}>
          <MessageCircle className="h-4 w-4 mr-1" />WhatsApp
        </Button>
      </div>
      {ask && (
        <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5">
          <span className="text-gray-700">{t.contact.reachedQ}</span>
          <button disabled={saving} onClick={() => log(true)} className="text-green-700 font-medium hover:underline">{t.contact.yes}</button>
          <button disabled={saving} onClick={() => log(false)} className="text-gray-500 hover:underline">{t.contact.no}</button>
        </div>
      )}
    </div>
  );
}
