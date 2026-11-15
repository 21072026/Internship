'use client';

import { useState, type ReactNode } from 'react';
import { Phone, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { apiErrorMessage } from '@/lib/apiErrorMessage';
import { stageAdvanceFrom, useStageAdvanceToast, type StageAdvance } from '@/components/useStageAdvanceToast';

// Quick contact channels for a person's number. Opens tel:/wa.me, then asks
// whether they were reached — a "yes" logs a Call/WhatsApp interaction through
// POST /api/interactions (owner-checked there), so the contact history builds up
// automatically. Used on a mentor's mentee page and on a sales rep's lead page
// (#3748); whoever renders it decides on the server whether the viewer may log.
// A "no" logs nothing.
//
// Two optional seams for a page that already has its own way in (the sales lead
// page's tel: link, #3741):
//   • `trigger` replaces the two buttons. It gets `prompt(channel)`, which only
//     asks the question — the trigger itself (a native tel: link) does the
//     dialling, so nothing is opened twice.
//   • `onAddNote` adds an "Add a note" choice next to Yes: it hands over to the
//     page's interaction form and logs nothing here, so a contact is never saved
//     twice. The only write stays the POST below.
type Channel = 'Call' | 'WhatsApp';

export function ContactActions({
  relationId,
  phone,
  onLogged,
  trigger,
  onAddNote,
}: {
  relationId: string;
  phone: string;
  onLogged?: () => void;
  trigger?: (prompt: (channel: Channel) => void) => ReactNode;
  onAddNote?: (channel: Channel) => void;
}) {
  const t = useT();
  const toast = useToast();
  const digits = phone.replace(/[^\d+]/g, '');
  const wa = digits.replace(/^\+/, '');
  const [ask, setAsk] = useState<null | Channel>(null);
  const [saving, setSaving] = useState(false);
  const stageAdvanceToast = useStageAdvanceToast();

  const open = (channel: Channel) => {
    const url = channel === 'Call' ? `tel:${digits}` : `https://wa.me/${wa}`;
    window.open(url, channel === 'Call' ? '_self' : '_blank');
    setAsk(channel);
  };

  const log = async (reached: boolean) => {
    const channel = ask;
    setAsk(null);
    if (!reached || !channel) return;
    setSaving(true);
    let logged = false;
    let advance: StageAdvance | null = null;
    let failure = '';
    // #1355: the response went unread, so a rejected POST still said "contact
    // logged" — and `onLogged` refetched a history that never gained the row.
    // Only the POST is guarded here.
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relationId,
          date: new Date().toISOString(),
          type: channel,
          notes: channel === 'Call' ? t.contact.loggedCall : t.contact.loggedWhatsApp,
        }),
      });
      if (res.ok) {
        logged = true;
        // A first contact may move the lead on (#3746): the same answer the
        // interaction form reads, so the same toast and Undo follow.
        advance = stageAdvanceFrom(await res.json().catch(() => null));
      } else failure = apiErrorMessage(res, t.common, t.contact.logFailed);
    } catch {
      failure = t.contact.logFailed;
    } finally {
      setSaving(false);
    }
    // The history refresh is outside that try: a refresh that fails must never
    // be narrated as "the contact was not logged" once the row exists.
    if (logged) {
      onLogged?.();
      if (advance) stageAdvanceToast(relationId, advance, () => onLogged?.());
      else toast(t.contact.logged);
    } else {
      toast(failure, 'error');
    }
  };

  const addNote = () => {
    const channel = ask;
    setAsk(null);
    if (channel) onAddNote?.(channel);
  };

  if (!digits) return null;

  return (
    <div className="inline-flex flex-col gap-2">
      {trigger ? trigger(setAsk) : <div className="inline-flex gap-2">
        <Button size="sm" variant="outline" onClick={() => open('Call')} data-testid="contact-call">
          <Phone className="h-4 w-4 mr-1" />{t.contact.call}
        </Button>
        <Button size="sm" variant="outline" onClick={() => open('WhatsApp')} data-testid="contact-whatsapp">
          <MessageCircle className="h-4 w-4 mr-1" />WhatsApp
        </Button>
      </div>}
      {ask && (
        // The blue-50 box is retinted dark by globals.css, which also lightens the
        // gray texts; the green "yes" has no such rule, so it carries its own
        // dark-mode colour or it goes dark-on-dark (#3748).
        <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5 dark:border-blue-900" data-testid="contact-reached">
          <span className="text-gray-700">{t.contact.reachedQ}</span>
          <button disabled={saving} onClick={() => log(true)} className="text-green-700 dark:text-green-300 font-medium hover:underline" data-testid="contact-reached-yes">{t.contact.yes}</button>
          <button disabled={saving} onClick={() => log(false)} className="text-gray-500 hover:underline" data-testid="contact-reached-no">{t.contact.no}</button>
          {onAddNote && (
            <button disabled={saving} onClick={addNote} className="text-blue-700 hover:underline" data-testid="contact-reached-note">{t.contact.addNote}</button>
          )}
        </div>
      )}
    </div>
  );
}
