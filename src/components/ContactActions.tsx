'use client';

import { useState, type ReactNode } from 'react';
import { Phone, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { apiErrorMessage } from '@/lib/apiErrorMessage';
import { stageAdvanceFrom, useStageAdvanceToast, type StageAdvance } from '@/components/useStageAdvanceToast';
import { FollowUpFields, localDayFromToday, type FollowUpValue } from '@/components/FollowUpFields';
import { followUpNoteMissing } from '@/lib/leadHandoffRule';
import { parseNextActionDate, parseNextActionTime } from '@/lib/nextActionRule';

// Quick contact channels for a person's number. Opens tel:/wa.me, then asks
// how it went — three answers, one record at most (#3904):
//
//   • "Reached"     → a small form: a note (optional) and, where the page passes
//                     the record's follow-up, "Complete the follow-up" (ticked
//                     when the open step is a call) and an optional next step
//                     (the shared FollowUpFields editor). Save writes ONE Call /
//                     WhatsApp interaction through POST /api/interactions — the
//                     only path that may move a first-stage lead on (#3746) —
//                     and then the follow-up through PUT /api/mentorship/[id]
//                     (`nextActionCompleted`, so its history says "completed").
//   • "Not reached" → an ATTEMPT (#3902, outcome NOT_REACHED): no contact, no
//                     stage move; the follow-up stays, and can be moved to
//                     tomorrow, in two days or a day and time.
//   • "Didn't call" → nothing at all: a mis-tap or a change of mind.
//
// Used on a mentor's mentee page, the admin candidate page and a sales rep's
// lead page (#3748); whoever renders it decides on the server whether the viewer
// may log. `trigger` replaces the two buttons (the sales lead page's own tel:
// link, #3741): it gets `prompt(channel)`, which only asks the question.
type Channel = 'Call' | 'WhatsApp';
type Step = null | { channel: Channel; stage: 'ask' | 'reached' | 'retry' };

/** The record's follow-up, for the owner only: absent, no follow-up control renders. */
export interface ContactFollowUp {
  /** A follow-up is open (a day or a note). */
  open: boolean;
  /** The open step is a call (#3900 pick, or the hand-off's label). */
  isCall: boolean;
}

const EMPTY_NEXT: FollowUpValue = { action: 'call', date: '', time: '', note: '' };

export function ContactActions({
  relationId,
  phone,
  onLogged,
  trigger,
  followUp,
}: {
  relationId: string;
  phone: string;
  onLogged?: () => void;
  trigger?: (prompt: (channel: Channel) => void) => ReactNode;
  followUp?: ContactFollowUp | null;
}) {
  const t = useT();
  const c = t.contact;
  const toast = useToast();
  const digits = phone.replace(/[^\d+]/g, '');
  const wa = digits.replace(/^\+/, '');
  const [step, setStep] = useState<Step>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [complete, setComplete] = useState(false);
  const [planNext, setPlanNext] = useState(false);
  const [next, setNext] = useState<FollowUpValue>(EMPTY_NEXT);
  const [retryDate, setRetryDate] = useState('');
  const [retryTime, setRetryTime] = useState('');
  const stageAdvanceToast = useStageAdvanceToast();

  const ask = (channel: Channel) => {
    setStep({ channel, stage: 'ask' });
    setError('');
  };

  const open = (channel: Channel) => {
    const url = channel === 'Call' ? `tel:${digits}` : `https://wa.me/${wa}`;
    window.open(url, channel === 'Call' ? '_self' : '_blank');
    ask(channel);
  };

  const close = () => {
    setStep(null);
    setError('');
  };

  const startReached = (channel: Channel) => {
    setNote('');
    setComplete(!!followUp?.open && followUp.isCall);
    setPlanNext(false);
    setNext(EMPTY_NEXT);
    setError('');
    setStep({ channel, stage: 'reached' });
  };

  /** The one interaction; `null` when it was not written (the toast already said why). */
  const postInteraction = async (body: Record<string, unknown>): Promise<{ advance: StageAdvance | null } | null> => {
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, date: new Date().toISOString(), ...body }),
      });
      if (!res.ok) {
        toast(apiErrorMessage(res, t.common, c.logFailed), 'error');
        return null;
      }
      return { advance: stageAdvanceFrom(await res.json().catch(() => null)) };
    } catch {
      toast(c.logFailed, 'error');
      return null;
    }
  };

  const putFollowUp = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const saveReached = async () => {
    if (!step) return;
    // The next step is checked before anything is written, so a bad one costs no contact.
    if (planNext) {
      if (!parseNextActionDate(next.date).ok || !next.date) return setError(t.followUp.invalidDate);
      if (!parseNextActionTime(next.time).ok) return setError(t.followUp.invalidTime);
      if (followUpNoteMissing(next.action, next.note)) return setError(t.leadHandoff.errors.note_required);
    }
    setError('');
    setSaving(true);
    try {
      const written = await postInteraction({
        type: step.channel,
        notes: note.trim() || (step.channel === 'Call' ? c.loggedCall : c.loggedWhatsApp),
      });
      if (!written) return;
      // The follow-up after the contact exists: a failure here never un-says the contact.
      let followUpOk = true;
      if (followUp && complete && followUp.open) {
        followUpOk = await putFollowUp({ nextActionAt: null, nextActionNote: null, nextActionTime: null, nextActionCompleted: true });
      }
      if (followUp && planNext && followUpOk) {
        followUpOk = await putFollowUp({
          nextActionAt: next.date,
          nextActionTime: next.time || null,
          nextActionNote: next.note.trim() || null,
          nextActionType: next.action ?? null,
        });
      }
      close();
      onLogged?.();
      if (!followUpOk) toast(c.followUpFailed, 'error');
      else if (written.advance) stageAdvanceToast(relationId, written.advance, () => onLogged?.());
      else toast(c.logged);
    } finally {
      setSaving(false);
    }
  };

  const saveNotReached = async (channel: Channel) => {
    setSaving(true);
    try {
      const written = await postInteraction({
        type: channel,
        outcome: 'NOT_REACHED',
        notes: channel === 'Call' ? c.notReachedCall : c.notReachedWhatsApp,
      });
      if (!written) return close();
      onLogged?.();
      toast(c.attemptLogged);
      // The follow-up stays; the owner may move it while the number is still in mind.
      if (followUp) {
        setRetryDate('');
        setRetryTime('');
        setError('');
        setStep({ channel, stage: 'retry' });
      } else close();
    } finally {
      setSaving(false);
    }
  };

  const moveFollowUp = async (date: string, time: string) => {
    if (!parseNextActionDate(date).ok || !date) return setError(t.followUp.invalidDate);
    if (!parseNextActionTime(time).ok) return setError(t.followUp.invalidTime);
    setSaving(true);
    try {
      // Only the day (and its time): the step and its words stay. With nothing open, a call is the step.
      const ok = await putFollowUp({
        nextActionAt: date,
        nextActionTime: time || null,
        ...(followUp?.open ? {} : { nextActionType: 'call' }),
      });
      if (!ok) return toast(t.followUp.saveError, 'error');
      close();
      onLogged?.();
      toast(c.followUpMoved);
    } finally {
      setSaving(false);
    }
  };

  if (!digits) return null;

  const box = 'flex flex-col gap-2 text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 dark:border-blue-900';
  const link = 'font-medium hover:underline disabled:opacity-50';

  return (
    <div className="inline-flex flex-col gap-2">
      {trigger ? trigger(ask) : <div className="inline-flex gap-2">
        <Button size="sm" variant="outline" onClick={() => open('Call')} data-testid="contact-call">
          <Phone className="h-4 w-4 mr-1" />{c.call}
        </Button>
        <Button size="sm" variant="outline" onClick={() => open('WhatsApp')} data-testid="contact-whatsapp">
          <MessageCircle className="h-4 w-4 mr-1" />WhatsApp
        </Button>
      </div>}

      {step?.stage === 'ask' && (
        // The blue-50 box is retinted dark by globals.css, which also lightens the
        // gray texts; the green and amber answers carry their own dark colours (#3748).
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5 dark:border-blue-900" data-testid="contact-reached">
          <span className="text-gray-700">{c.reachedQ}</span>
          <button disabled={saving} onClick={() => startReached(step.channel)} className={`${link} text-green-700 dark:text-green-300`} data-testid="contact-reached-yes">{c.reached}</button>
          <button disabled={saving} onClick={() => saveNotReached(step.channel)} className={`${link} text-amber-700 dark:text-amber-300`} data-testid="contact-reached-no">{c.notReached}</button>
          <button disabled={saving} onClick={close} className="text-gray-500 hover:underline" data-testid="contact-reached-skip">{c.notCalled}</button>
        </div>
      )}

      {step?.stage === 'reached' && (
        <div className={box} data-testid="contact-reached-form">
          <Textarea
            aria-label={c.notePlaceholder}
            placeholder={c.notePlaceholder}
            value={note}
            rows={2}
            disabled={saving}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            data-testid="contact-reached-note"
          />
          {followUp?.open && (
            <label className="inline-flex items-center gap-2 text-gray-700">
              <input type="checkbox" checked={complete} disabled={saving} onChange={(e) => setComplete(e.target.checked)} data-testid="contact-reached-complete" />
              {c.completeFollowUp}
            </label>
          )}
          {followUp && (
            <label className="inline-flex items-center gap-2 text-gray-700">
              <input type="checkbox" checked={planNext} disabled={saving} onChange={(e) => setPlanNext(e.target.checked)} data-testid="contact-reached-next" />
              {c.nextFollowUp}
            </label>
          )}
          {followUp && planNext && (
            <FollowUpFields
              value={next}
              onChange={setNext}
              idPrefix={`contact-next-${relationId}`}
              testIdPrefix="contact-next"
              actions
              quickDates
              disabled={saving}
            />
          )}
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" loading={saving} onClick={saveReached} data-testid="contact-reached-save">{c.save}</Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={close} data-testid="contact-reached-cancel">{c.cancel}</Button>
          </div>
        </div>
      )}

      {step?.stage === 'retry' && (
        <div className={box} data-testid="contact-retry">
          <span className="text-gray-700">{followUp?.open ? c.retryMove : c.retryPlan}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={saving} onClick={() => moveFollowUp(localDayFromToday(1), '')} data-testid="contact-retry-1">{t.followUp.quickTomorrow}</Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => moveFollowUp(localDayFromToday(2), '')} data-testid="contact-retry-2">{c.retryIn2Days}</Button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)_auto] items-end gap-2">
            <Input id={`contact-retry-date-${relationId}`} type="date" label={t.followUp.date} value={retryDate} disabled={saving} onChange={(e) => setRetryDate(e.target.value)} data-testid="contact-retry-date" />
            <Input id={`contact-retry-time-${relationId}`} type="time" label={t.followUp.time} value={retryTime} disabled={saving || !retryDate} onChange={(e) => setRetryTime(e.target.value)} data-testid="contact-retry-time" />
            <Button size="sm" disabled={saving || !retryDate} onClick={() => moveFollowUp(retryDate, retryTime)} data-testid="contact-retry-save">{c.retrySave}</Button>
          </div>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <button disabled={saving} onClick={close} className="self-start text-gray-500 hover:underline" data-testid="contact-retry-skip">{c.retryKeep}</button>
        </div>
      )}
    </div>
  );
}
