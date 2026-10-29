'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { CompensationSummary } from '@/components/CompensationSummary';
import { OfferLetterView } from '@/components/OfferLetterView';
import { compensationLine, renderOfferLetter } from '@/lib/offerLetter';
import { BUILT_IN_OFFER_LETTERS } from '@/lib/offerLetterTemplates';
import { formatDate } from '@/lib/relativeTime';
import { formatMinorAmount, parseMinorUnits } from '@/lib/money';
import {
  BASE_PERIODS,
  CONTRACT_TYPES,
  EQUITY_NOTE_MAX,
  MAX_HOURS_PER_WEEK,
  OFFER_CURRENCIES,
  validateCompensation,
  type CompensationFields,
} from '@/lib/compensation';

export interface OfferDraftFields {
  id?: string;
  position: string;
  requisitionId: string;
  requisitionTitle?: string | null;
  startDate: string; // yyyy-mm-dd
  compensationNote: string;
  expiresAt: string; // yyyy-mm-dd
  // Structured compensation (#1851), held as the TYPED text until save: the
  // amounts are parsed with parseMinorUnits (money.ts) into integer minor
  // units, so "2.500,00" and "2,500.00" both become 250000 and never a float.
  currency: string;
  baseAmount: string;
  basePeriod: string;
  hoursPerWeek: string;
  contractType: string;
  signingBonus: string;
  otherBonus: string;
  equityNote: string;
}

const EMPTY: OfferDraftFields = {
  position: '', requisitionId: '', startDate: '', compensationNote: '', expiresAt: '',
  currency: '', baseAmount: '', basePeriod: '', hoursPerWeek: '', contractType: '', signingBonus: '', otherBonus: '', equityNote: '',
};

/** The structured figures of the form as the API's field set — or `'invalid'`
 * when an amount could not be read, so the user is told instead of a 0 saved. */
function figuresFrom(f: OfferDraftFields): CompensationFields | 'invalid' {
  const money = (raw: string): number | null | 'invalid' => {
    const parsed = parseMinorUnits(raw);
    if (parsed === null) return null;
    return Number.isNaN(parsed) || parsed < 0 ? 'invalid' : parsed;
  };
  const base = money(f.baseAmount);
  const signing = money(f.signingBonus);
  const other = money(f.otherBonus);
  if (base === 'invalid' || signing === 'invalid' || other === 'invalid') return 'invalid';
  const hours = f.hoursPerWeek.trim() ? Number(f.hoursPerWeek) : null;
  return {
    currency: f.currency || null,
    baseAmountMinor: base,
    basePeriod: f.basePeriod || null,
    signingBonusMinor: signing,
    otherBonusMinor: other,
    equityNote: f.equityNote.trim() || null,
    hoursPerWeek: hours != null && Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS_PER_WEEK ? hours : null,
    contractType: f.contractType || null,
  };
}

interface OfferWizardModalProps {
  open: boolean;
  relationId: string;
  menteeName: string;
  companyName?: string | null;
  companyId: string | null;
  existing?: OfferDraftFields | null;
  onClose: () => void;
  onSaved: () => void;
}

// 3-step admin flow: offer details -> date & compensation -> preview & send
// (issue #809). Creating always lands the offer in DRAFT first; "Save and
// send" chains the create/edit call with a PATCH { action: 'send' } so the
// two writes stay in the same place as every other transition.
export function OfferWizardModal({ open, relationId, menteeName, companyName, companyId, existing, onClose, onSaved }: OfferWizardModalProps) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [step, setStep] = useState(1);
  // The letter preview (#1857): the org's template for the admin's language,
  // else the built-in. A reader without settings access sees the built-in.
  const [letterTemplate, setLetterTemplate] = useState<string>(BUILT_IN_OFFER_LETTERS[locale]);
  const [fields, setFields] = useState<OfferDraftFields>(existing ?? EMPTY);
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [requisitions, setRequisitions] = useState<{ id: string; title: string }[]>([]);
  const [requisitionsLoading, setRequisitionsLoading] = useState(false);
  const [requisitionsError, setRequisitionsError] = useState(false);
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) {
      setFields(existing ?? EMPTY);
      setStep(1);
    }
  }, [open, existing]);

  useEffect(() => {
    if (!open || !companyId) {
      setRequisitions([]);
      setRequisitionsLoading(false);
      setRequisitionsError(false);
      return;
    }
    const controller = new AbortController();
    setRequisitions([]);
    setRequisitionsLoading(true);
    setRequisitionsError(false);
    const params = new URLSearchParams({ status: 'OPEN', companyId });
    fetch(`/api/requisitions?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        setRequisitions(data.requisitions ?? []);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRequisitionsError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRequisitionsLoading(false);
      });
    return () => controller.abort();
  }, [open, companyId]);

  useEffect(() => {
    if (!open || step !== 3) return;
    const controller = new AbortController();
    fetch('/api/admin/offer-templates', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { templates?: { locale: string; bodyMarkdown: string }[] } | null) => {
        const mine = data?.templates?.find((x) => x.locale === locale);
        if (mine) setLetterTemplate(mine.bodyMarkdown);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open, step, locale]);

  if (!open) return null;

  const set = (patch: Partial<OfferDraftFields>) => setFields((f) => ({ ...f, ...patch }));

  const figures = figuresFrom(fields);
  const figuresProblem = figures === 'invalid' ? 'invalid' : validateCompensation(figures);

  const save = async (send: boolean) => {
    if (figures === 'invalid') {
      toast(t.offers.wizard.amountInvalid, 'error');
      return;
    }
    if (figuresProblem) {
      toast(t.offers.wizard.compensationInvalid, 'error');
      return;
    }
    setBusy(send ? 'send' : 'draft');
    try {
      const body = {
        position: fields.position.trim(),
        requisitionId: fields.requisitionId.trim() || null,
        startDate: fields.startDate || null,
        compensationNote: fields.compensationNote.trim() || null,
        ...figures,
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-testid="offer-wizard-modal"
        tabIndex={-1}
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
            <Select
              label={t.offers.wizard.requisitionId}
              value={fields.requisitionId}
              onChange={(e) => set({ requisitionId: e.target.value })}
              disabled={!companyId || requisitionsLoading}
              hint={requisitionsLoading ? t.offers.wizard.requisitionLoading : undefined}
              error={requisitionsError ? t.offers.wizard.requisitionLoadError : undefined}
              options={[
                { value: '', label: t.offers.wizard.noRequisition },
                ...(!requisitions.some((item) => item.id === fields.requisitionId) && fields.requisitionId && existing?.requisitionTitle
                  ? [{ value: fields.requisitionId, label: existing.requisitionTitle }]
                  : []),
                ...requisitions.map((item) => ({ value: item.id, label: item.title })),
              ]}
              data-testid="offer-requisition-select"
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
            <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-3 space-y-3" data-testid="offer-compensation-fields">
              <p className="text-xs font-medium text-gray-500">{t.offers.wizard.figuresTitle}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Select
                  label={t.offers.wizard.currency}
                  value={fields.currency}
                  onChange={(e) => set({ currency: e.target.value })}
                  options={[{ value: '', label: '—' }, ...OFFER_CURRENCIES.map((code) => ({ value: code, label: code }))]}
                  data-testid="offer-currency"
                />
                <Input
                  label={t.offers.wizard.baseAmount}
                  placeholder={t.offers.wizard.baseAmountPlaceholder}
                  inputMode="decimal"
                  value={fields.baseAmount}
                  onChange={(e) => set({ baseAmount: e.target.value })}
                  error={figures === 'invalid' ? t.offers.wizard.amountInvalid : undefined}
                  data-testid="offer-base-amount"
                />
                <Select
                  label={t.offers.wizard.basePeriod}
                  value={fields.basePeriod}
                  onChange={(e) => set({ basePeriod: e.target.value })}
                  options={[{ value: '', label: '—' }, ...BASE_PERIODS.map((period) => ({ value: period, label: t.offers.compensation.periods[period] }))]}
                  data-testid="offer-base-period"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label={t.offers.wizard.hoursPerWeek}
                  type="number"
                  min={1}
                  max={MAX_HOURS_PER_WEEK}
                  value={fields.hoursPerWeek}
                  onChange={(e) => set({ hoursPerWeek: e.target.value })}
                  data-testid="offer-hours-per-week"
                />
                <Select
                  label={t.offers.wizard.contractType}
                  value={fields.contractType}
                  onChange={(e) => set({ contractType: e.target.value })}
                  options={[{ value: '', label: t.offers.wizard.noContractType }, ...CONTRACT_TYPES.map((type) => ({ value: type, label: t.offers.compensation.contractTypes[type] }))]}
                  data-testid="offer-contract-type"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label={t.offers.wizard.signingBonus}
                  inputMode="decimal"
                  value={fields.signingBonus}
                  onChange={(e) => set({ signingBonus: e.target.value })}
                  data-testid="offer-signing-bonus"
                />
                <Input
                  label={t.offers.wizard.otherBonus}
                  inputMode="decimal"
                  value={fields.otherBonus}
                  onChange={(e) => set({ otherBonus: e.target.value })}
                  data-testid="offer-other-bonus"
                />
              </div>
              <Input
                label={t.offers.wizard.equityNote}
                maxLength={EQUITY_NOTE_MAX}
                value={fields.equityNote}
                onChange={(e) => set({ equityNote: e.target.value })}
                data-testid="offer-equity-note"
              />
              {figuresProblem && figuresProblem !== 'invalid' && (
                <p className="text-xs text-red-600">{t.offers.wizard.compensationInvalid}</p>
              )}
              <p className="text-xs text-gray-500">{t.offers.wizard.figuresHint}</p>
            </div>
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
              {figures !== 'invalid' && <CompensationSummary offer={figures} testId="offer-wizard-compensation-preview" />}
              {fields.compensationNote && (
                <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{fields.compensationNote}</p>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-400">{t.offers.sensitiveNote}</p>
            <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 p-4" data-testid="offer-wizard-letter-preview">
              <p className="text-xs font-medium text-gray-500 mb-2">{t.offers.letter.title}</p>
              <div className="max-h-72 overflow-y-auto">
                <OfferLetterView
                  markdown={renderOfferLetter(letterTemplate, {
                    candidateName: menteeName,
                    position: fields.position,
                    companyName: companyName ?? '—',
                    startDate: fields.startDate ? formatDate(`${fields.startDate}T00:00:00Z`, locale, { month: 'long', timeZone: 'UTC' }) : '—',
                    compensation: compensationLine(
                      { ...(figures === 'invalid' ? {} : figures), compensationNote: fields.compensationNote },
                      t.offers.compensation,
                      (m, cur) => formatMinorAmount(m, cur, locale),
                    ),
                    expiresAt: fields.expiresAt ? formatDate(`${fields.expiresAt}T00:00:00Z`, locale, { month: 'long', timeZone: 'UTC' }) : '—',
                    programName: '',
                  })}
                />
              </div>
              <p className="mt-2 text-xs text-gray-400">{t.offers.letter.previewHint}</p>
            </div>
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
