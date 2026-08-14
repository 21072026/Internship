'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';

export interface OfferDraftFields {
  id?: string;
  position: string;
  requisitionId: string;
  startDate: string; // yyyy-mm-dd
  compensationNote: string;
  expiresAt: string; // yyyy-mm-dd
}

const EMPTY: OfferDraftFields = { position: '', requisitionId: '', startDate: '', compensationNote: '', expiresAt: '' };

interface OfferWizardModalProps {
  open: boolean;
  relationId: string;
  menteeName: string;
  companyName?: string | null;
  existing?: OfferDraftFields | null;
  onClose: () => void;
  onSaved: () => void;
}

// 3-step admin flow: offer details -> date & compensation -> preview & send
// (issue #809). Creating always lands the offer in DRAFT first; "Save and
// send" chains the create/edit call with a PATCH { action: 'send' } so the
// two writes stay in the same place as every other transition.
export function OfferWizardModal({ open, relationId, menteeName, companyName, existing, onClose, onSaved }: OfferWizardModalProps) {
  const t = useT();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [fields, setFields] = useState<OfferDraftFields>(existing ?? EMPTY);
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);

  useEffect(() => {
    if (open) {
      setFields(existing ?? EMPTY);
      setStep(1);
    }
  }, [open, existing]);

  if (!open) return null;

  const set = (patch: Partial<OfferDraftFields>) => setFields((f) => ({ ...f, ...patch }));

  const save = async (send: boolean) => {
    setBusy(send ? 'send' : 'draft');
    try {
      const body = {
        position: fields.position.trim(),
        requisitionId: fields.requisitionId.trim() || null,
        startDate: fields.startDate || null,
        compensationNote: fields.compensationNote.trim() || null,
        expiresAt: fields.expiresAt || null,
      };
      const res = fields.id
        ? await fetch(`/api/offers/${fields.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, relationId }) });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const id: string = data.offer.id;

      if (send) {
        const sendRes = await fetch(`/api/offers/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send' }),
        });
        if (!sendRes.ok) throw new Error();
      }

      toast(t.offers.saved);
      onSaved();
      onClose();
    } catch {
      toast(t.offers.saveError, 'error');
    } finally {
      setBusy(null);
    }
  };

  const canNext = step === 1 ? fields.position.trim().length > 0 : true;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        data-testid="offer-wizard-modal"
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4 text-xs font-medium text-gray-500">
          {[t.offers.wizard.step1, t.offers.wizard.step2, t.offers.wizard.step3].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full ${
                  step === i + 1 ? 'bg-blue-600 text-white' : step > i + 1 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'
                }`}
              >
                {i + 1}
              </span>
              <span className={step === i + 1 ? 'text-gray-900 dark:text-gray-100' : ''}>{label}</span>
              {i < 2 && <span className="text-gray-300">—</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4" data-testid="offer-wizard-step-1">
            <Input
              label={t.offers.wizard.position}
              placeholder={t.offers.wizard.positionPlaceholder}
              required
              value={fields.position}
              onChange={(e) => set({ position: e.target.value })}
            />
            <Input
              label={t.offers.wizard.requisitionId}
              value={fields.requisitionId}
              onChange={(e) => set({ requisitionId: e.target.value })}
            />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4" data-testid="offer-wizard-step-2">
            <Input
              label={t.offers.wizard.startDate}
              type="date"
              value={fields.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
            <Input
              label={t.offers.wizard.expiresAt}
              type="date"
              value={fields.expiresAt}
              onChange={(e) => set({ expiresAt: e.target.value })}
            />
            <div>
              <Textarea
                aria-label={t.offers.wizard.compensationNote}
                placeholder={t.offers.wizard.compensationNote}
                maxLength={2000}
                showCounter
                value={fields.compensationNote}
                onChange={(e) => set({ compensationNote: e.target.value })}
              />
              <p className="mt-1 text-xs text-gray-500">{t.offers.wizard.compensationHint}</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div data-testid="offer-wizard-step-3">
            <p className="text-xs font-medium text-gray-500 mb-2">{t.offers.wizard.previewTitle}</p>
            <div className="rounded-xl border border-blue-100 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-800 p-4 space-y-1.5">
              <p className="font-semibold text-gray-900 dark:text-gray-100">{fields.position}</p>
              {companyName && <p className="text-sm text-gray-600 dark:text-gray-300">{companyName}</p>}
              <p className="text-sm text-gray-500">{menteeName}</p>
              {fields.startDate && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t.offers.wizard.startDate}: {fields.startDate}
                </p>
              )}
              {fields.expiresAt && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t.offers.wizard.expiresAt}: {fields.expiresAt}
                </p>
              )}
              {fields.compensationNote && (
                <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{fields.compensationNote}</p>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-400">{t.offers.sensitiveNote}</p>
          </div>
        )}

        <div className="mt-6 flex justify-between gap-2">
          <Button type="button" variant="secondary" onClick={step === 1 ? onClose : () => setStep((s) => s - 1)}>
            {step === 1 ? t.offers.wizard.cancel : t.offers.wizard.back}
          </Button>
          {step < 3 ? (
            <Button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              {t.offers.wizard.next}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="outline" loading={busy === 'draft'} disabled={busy !== null} onClick={() => save(false)}>
                {t.offers.wizard.saveDraft}
              </Button>
              <Button type="button" loading={busy === 'send'} disabled={busy !== null} onClick={() => save(true)}>
                {t.offers.wizard.sendNow}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
