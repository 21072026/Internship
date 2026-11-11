// Where an affiliate customer stands in a partner's funnel (docs/affiliate-module.md,
// "Customer status", #3542). The partner portal (#3543) and the admin screens (#3544)
// read this ONE rule; the counts come from `partnerCustomerStatusCounts()`
// (src/lib/affiliateCustomerStatus.ts).
//
// PURE and dependency-free: no database, no clock — `now` is an input. Both
// thresholds are programme settings (`freeMonths`, `passiveAfterDays` on
// AffiliateProgramSettings), not part of the commission plan.
//
//   FREE_PERIOD — no payment, not ended, and the free period since registration
//                 has not run out yet.
//   NEVER_PAID  — no payment, and the free period has run out or the account ended.
//   ACTIVE      — the last payment is less than `passiveAfterDays` old, and the
//                 account has not ended since.
//   PASSIVE     — paid before, but the last payment is `passiveAfterDays` or more
//                 old, or the account ended after it.
//
// An end (`endedAt`, a `cancelled`/`deactivated` account event) counts only when
// no payment arrived after it: a payment received after the end is the customer
// coming back, whatever order the events reached us in.
import { addMonthsUtc } from './affiliateCommissionRule';

export const CUSTOMER_STATUSES = ['FREE_PERIOD', 'NEVER_PAID', 'ACTIVE', 'PASSIVE'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const DEFAULT_FREE_MONTHS = 2;
export const DEFAULT_PASSIVE_AFTER_DAYS = 45;
/** The ranges a setting is accepted in (the form and the writer share them). */
export const FREE_MONTHS_RANGE = { min: 0, max: 36 } as const;
export const PASSIVE_AFTER_DAYS_RANGE = { min: 1, max: 730 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CustomerStatusSettings {
  freeMonths: number;
  passiveAfterDays: number;
}

export interface CustomerStatusInput {
  /** When the customer registered (`AffiliateCustomer.createdAt`). */
  registeredAt: Date;
  /** The newest payment's `receivedAt`; null when the customer never paid. */
  lastPaymentAt: Date | null;
  /** `AffiliateCustomer.endedAt`: the account's cancellation, null when live. */
  endedAt: Date | null;
  now: Date;
  settings: CustomerStatusSettings;
}

export function customerStatus(input: CustomerStatusInput): CustomerStatus {
  const { registeredAt, lastPaymentAt, endedAt, now, settings } = input;
  if (lastPaymentAt === null) {
    if (endedAt !== null) return 'NEVER_PAID';
    return now.getTime() < addMonthsUtc(registeredAt, settings.freeMonths).getTime() ? 'FREE_PERIOD' : 'NEVER_PAID';
  }
  const ended = endedAt !== null && endedAt.getTime() >= lastPaymentAt.getTime();
  if (ended) return 'PASSIVE';
  return now.getTime() - lastPaymentAt.getTime() < settings.passiveAfterDays * DAY_MS ? 'ACTIVE' : 'PASSIVE';
}

/** An empty tally, every status present. */
export function emptyStatusCounts(): Record<CustomerStatus, number> {
  return { FREE_PERIOD: 0, NEVER_PAID: 0, ACTIVE: 0, PASSIVE: 0 };
}

export type SettingIssue = 'invalid' | 'range';

function intIn(raw: unknown, range: { min: number; max: number }): number | SettingIssue {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'invalid';
  return raw < range.min || raw > range.max ? 'range' : raw;
}

/** Validates the two settings as the admin form sends them. */
export function parseCustomerStatusSettings(
  raw: unknown,
): { ok: true; settings: CustomerStatusSettings } | { ok: false; issues: { field: keyof CustomerStatusSettings; code: SettingIssue }[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const freeMonths = intIn(o.freeMonths, FREE_MONTHS_RANGE);
  const passiveAfterDays = intIn(o.passiveAfterDays, PASSIVE_AFTER_DAYS_RANGE);
  const issues: { field: keyof CustomerStatusSettings; code: SettingIssue }[] = [];
  if (typeof freeMonths === 'string') issues.push({ field: 'freeMonths', code: freeMonths });
  if (typeof passiveAfterDays === 'string') issues.push({ field: 'passiveAfterDays', code: passiveAfterDays });
  if (typeof freeMonths === 'string' || typeof passiveAfterDays === 'string') return { ok: false, issues };
  return { ok: true, settings: { freeMonths, passiveAfterDays } };
}

/** The stored columns as settings, the defaults for an org without a row. */
export function storedCustomerStatusSettings(row: { freeMonths?: number | null; passiveAfterDays?: number | null } | null | undefined): CustomerStatusSettings {
  return {
    freeMonths: row?.freeMonths ?? DEFAULT_FREE_MONTHS,
    passiveAfterDays: row?.passiveAfterDays ?? DEFAULT_PASSIVE_AFTER_DAYS,
  };
}
