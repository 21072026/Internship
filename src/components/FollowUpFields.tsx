'use client';

import { Input } from '@/components/ui/Input';
import { useT } from '@/i18n/client';
import { NEXT_ACTION_NOTE_MAX } from '@/lib/nextActionRule';
import { HANDOFF_ACTIONS, type HandoffAction } from '@/lib/leadHandoffRule';

// One follow-up editor (#3903): WHAT is next (the hand-off's quick picks), WHEN
// (quick days or a day, plus an optional time) and the words. The hand-off
// dialog and the sales follow-up panel both render it, so the two screens offer
// the same fields with the same rule — `other` IS the words and needs some
// (followUpNoteMissing in leadHandoffRule.ts, the route's `note_required`).
// Controlled and presentation only: each caller owns its state and its write.

export interface FollowUpValue {
  /** Absent where the screen offers no picks (the internship follow-up). */
  action?: HandoffAction | null;
  date: string;
  time: string;
  note: string;
}

/** The local calendar day `days` from today, as the `YYYY-MM-DD` a date input reads. */
export function localDayFromToday(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const QUICK_DAYS = [
  { days: 0, key: 'quickToday' },
  { days: 1, key: 'quickTomorrow' },
  { days: 3, key: 'quick3Days' },
  { days: 7, key: 'quick1Week' },
  { days: 14, key: 'quick2Weeks' },
] as const;

const CHIP_CLASS =
  'rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:border-blue-400 hover:text-blue-700 ' +
  'dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-400 dark:hover:text-blue-300 disabled:opacity-50';

export function FollowUpFields({
  value,
  onChange,
  idPrefix,
  testIdPrefix,
  actions = false,
  quickDates = false,
  disabled = false,
  autoFocus = false,
  notePlaceholder,
}: {
  value: FollowUpValue;
  onChange: (next: FollowUpValue) => void;
  /** Unique per page: the inputs' ids (labels point at them). */
  idPrefix: string;
  /** `follow-up` on the panel, `lead-handoff` in the dialog: `<prefix>-date`, `-time`, `-note`, `-action-<a>`, `-quick-<days>`. */
  testIdPrefix: string;
  /** Offer the quick picks (what is next). */
  actions?: boolean;
  /** Offer "Today · Tomorrow · 3 days · 1 week · 2 weeks". */
  quickDates?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The placeholder when the pick does not make the words the step. */
  notePlaceholder?: string;
}) {
  const t = useT();
  const h = t.leadHandoff;
  const set = (patch: Partial<FollowUpValue>) => onChange({ ...value, ...patch });
  const noteIsStep = actions && value.action === 'other';

  return (
    <div className="space-y-3">
      {actions && (
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{h.actionLabel}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {HANDOFF_ACTIONS.map((a) => (
              <label
                key={a}
                className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm ${
                  value.action === a
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200'
                }`}
              >
                <input
                  type="radio"
                  name={`${idPrefix}-action`}
                  value={a}
                  checked={value.action === a}
                  disabled={disabled}
                  onChange={() => set({ action: a })}
                  data-testid={`${testIdPrefix}-action-${a}`}
                  className="sr-only"
                />
                {h.actions[a]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)] gap-3">
        <Input
          id={`${idPrefix}-date`}
          type="date"
          label={t.followUp.date}
          value={value.date}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => set({ date: e.target.value })}
          data-testid={`${testIdPrefix}-date`}
        />
        {/* Optional (#3901): orders the day's steps; the day alone decides due and overdue. */}
        <Input
          id={`${idPrefix}-time`}
          type="time"
          label={t.followUp.time}
          value={value.time}
          disabled={disabled || !value.date}
          onChange={(e) => set({ time: e.target.value })}
          data-testid={`${testIdPrefix}-time`}
        />
      </div>

      {quickDates && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.followUp.quickLabel} data-testid={`${testIdPrefix}-quick-dates`}>
          <span className="text-xs text-gray-600 dark:text-gray-400">{t.followUp.quickLabel}</span>
          {QUICK_DAYS.map(({ days, key }) => {
            const day = localDayFromToday(days);
            return (
              <button
                key={key}
                type="button"
                className={`${CHIP_CLASS} ${value.date === day ? '!border-blue-500 !text-blue-700 dark:!text-blue-300' : ''}`}
                aria-pressed={value.date === day}
                disabled={disabled}
                onClick={() => set({ date: day })}
                data-testid={`${testIdPrefix}-quick-${days}`}
              >
                {t.followUp[key]}
              </button>
            );
          })}
        </div>
      )}

      <Input
        id={`${idPrefix}-note`}
        label={t.followUp.note}
        placeholder={noteIsStep ? h.notePlaceholderOther : notePlaceholder ?? t.followUp.notePlaceholder}
        value={value.note}
        maxLength={NEXT_ACTION_NOTE_MAX}
        required={noteIsStep}
        disabled={disabled}
        onChange={(e) => set({ note: e.target.value })}
        data-testid={`${testIdPrefix}-note`}
      />
    </div>
  );
}
