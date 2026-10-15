// The MARKETING price list as per-organization DATA (#2927) — the rule.
//
// What a marketing host publishes on /pricing (and quotes in the landing FAQ)
// is the price list of the organization bound to that host
// (`Organization.publicHost`), stored in its `marketingPriceList` setting
// (src/lib/settings.ts) as one JSON document:
//
//   {
//     "currency": "EUR",
//     "plans": [
//       { "key": "team", "annualSeatMinor": 4900, "monthlySeatMinor": 5900,
//         "minSeats": 1, "onboardingMinor": 0 },
//       …
//     ]
//   }
//
// Money is integer MINOR units plus an ISO code, like every other amount the
// app stores (`ProgramCost`, `Offer`, deal values) — never a float. Only
// two-decimal currencies are accepted (the deal-value list): a zero-decimal one
// would print a hundred times too large through src/lib/money.ts.
//
// A plan's `key` is one of MARKETING_PLAN_KEYS because the plan's name,
// description and feature list are translated copy keyed by it
// (`mkt<Plan>Name`… in the `pricing` dictionary); the data decides which plans
// exist and what they cost, the dictionary what they are called. Plans are
// listed in key order, each key at most once, because the cards stack
// ("Everything in Team, plus").
//
// There is NO built-in list: prices are a tenant's business, so they live only
// as that tenant's data. An unset setting reads as "no list" (`source: 'none'`)
// and a stored value that no longer parses as `invalid`, also without a list —
// the page then shows its neutral "contact us for pricing" state, never an
// empty or half-parsed price list. The resolver says which case it returned, so
// the caller can log a broken row instead of hiding it.
//
// The one writer is the operator CLI `prisma/set-org-pricing.mjs`; its plain-ESM
// validator mirrors `priceListSchema` below (the server runs Node 20, which
// cannot import TypeScript), and scripts/test/marketing-price-list.test.mjs
// runs both over one corpus so they cannot drift — change one, change both.
//
// No `@/` imports, so the unit test can load this file directly.

import { z } from 'zod';
import { MARKETING_PLAN_KEYS, type MarketingPlanKey } from './marketingPlans';

/** Two-decimal currencies only — the same closed list deal values use. */
export const PRICE_LIST_CURRENCIES = ['EUR', 'CHF', 'GBP', 'USD', 'TRY'] as const;
export type PriceListCurrency = (typeof PRICE_LIST_CURRENCIES)[number];

/** 100 000.00 per user and month: anything above is a typo (cents typed as units). */
export const PRICE_LIST_MAX_SEAT_MINOR = 10_000_000;
/** 1 000 000.00 one-time. */
export const PRICE_LIST_MAX_ONBOARDING_MINOR = 100_000_000;
export const PRICE_LIST_MAX_MIN_SEATS = 10_000;
/** The stored JSON text, at most: a full three-plan list is a few hundred characters. */
export const PRICE_LIST_MAX_LENGTH = 4_000;

export interface PriceListPlan {
  key: MarketingPlanKey;
  /** Per user per month on an annual contract. */
  annualSeatMinor: number;
  /** Per user per month month-to-month; null = annual only. */
  monthlySeatMinor: number | null;
  /** The smallest team the plan is sold to. */
  minSeats: number;
  /** One-time onboarding fee; 0 = none. */
  onboardingMinor: number;
}

export interface PriceList {
  currency: PriceListCurrency;
  plans: PriceListPlan[];
}

const seatMinor = z.number().int().min(1).max(PRICE_LIST_MAX_SEAT_MINOR);

const planSchema = z
  .object({
    key: z.enum(MARKETING_PLAN_KEYS),
    annualSeatMinor: seatMinor,
    monthlySeatMinor: seatMinor.nullable(),
    minSeats: z.number().int().min(1).max(PRICE_LIST_MAX_MIN_SEATS),
    onboardingMinor: z.number().int().min(0).max(PRICE_LIST_MAX_ONBOARDING_MINOR),
  })
  .strict();

/** The shape of a stored price list. Unknown fields are refused, not ignored. */
export const priceListSchema = z
  .object({
    currency: z.enum(PRICE_LIST_CURRENCIES),
    plans: z.array(planSchema).min(1).max(MARKETING_PLAN_KEYS.length),
  })
  .strict()
  .superRefine((list, ctx) => {
    const order = list.plans.map((p) => MARKETING_PLAN_KEYS.indexOf(p.key));
    for (let i = 1; i < order.length; i++) {
      if (order[i] <= order[i - 1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plans', i, 'key'],
          message: `plans are listed once each, in the order ${MARKETING_PLAN_KEYS.join(', ')}`,
        });
      }
    }
  });

export type PriceListParse = { ok: true; value: PriceList } | { ok: false; errors: string[] };

/** A stored (or about-to-be-stored) price list text → the list, or why not. */
export function parsePriceList(raw: string | null | undefined): PriceListParse {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, errors: ['empty'] };
  if (text.length > PRICE_LIST_MAX_LENGTH) return { ok: false, errors: [`longer than ${PRICE_LIST_MAX_LENGTH} characters`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not JSON'] };
  }
  const parsed = priceListSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  return { ok: true, value: parsed.data as PriceList };
}

export type PriceListSource = 'org' | 'none' | 'invalid';

export type ResolvedPriceList =
  | { source: 'org'; list: PriceList }
  | { source: 'none' | 'invalid'; list: null };

/**
 * The list a page shows for a stored setting value: the stored one when it
 * parses, else none. `source` is `none` for an unset value and `invalid` for a
 * value that is set but does not parse (the caller logs it).
 */
export function resolvePriceList(raw: string | null | undefined): ResolvedPriceList {
  if (!(raw ?? '').trim()) return { source: 'none', list: null };
  const parsed = parsePriceList(raw);
  return parsed.ok ? { source: 'org', list: parsed.value } : { source: 'invalid', list: null };
}

/** The "from" price the landing FAQ quotes: the cheapest annual seat. */
export function priceListFromSeatMinor(list: PriceList): number {
  return Math.min(...list.plans.map((p) => p.annualSeatMinor));
}
