// Programme ROI — the single ROI model in this tree (#1892).
//
// "What did this programme return?" is the question that stalls a deal at the
// business-case stage. This module answers it, and it is the ONLY module that
// answers it: the internal report (/admin/analytics/roi, #1895) and the public
// calculator (/roi-calculator, #1755) both compute through `computeRoi()`. A
// public calculator that prints a different number from the admin report is a
// credibility problem, so there is exactly one implementation and no second
// assumption set anywhere.
//
// THREE PROPERTIES THIS FILE IS BUILT AROUND
//
//   1. DETERMINISTIC. Every input arrives as an argument. No `Date.now()`, no
//      `Math.random()`, no environment read — and, as a consequence of (2), no
//      database. The same input object always produces the same output object,
//      which is what makes the unit tests meaningful and what stops the same
//      window from rendering two different numbers on two screens.
//
//   2. NO PRISMA IMPORT, EVER. #1755 renders this from a public *client*
//      component, so this file has to survive being bundled for the browser.
//      Importing anything server-only here breaks that build — and would also
//      let a clock or a query sneak back in through the back door.
//
//   3. INTEGER MONEY ONLY. Every amount is an integer in MINOR units (cents,
//      kuruş, …) plus an ISO 4217 code. Nothing here ever adds two floats: a
//      total that changes with the order of its rows is worse than no total.
//      Division happens exactly twice — cost-per-placement and the ROI
//      percentage — and both are rounded once, explicitly, at the end (see
//      `roundMinor` / `roundPercent`).
//
// ROUNDING, STATED ONCE. Money is rounded HALF AWAY FROM ZERO
// (−2.5 → −3, 2.5 → 3), not with bare `Math.round()`, which rounds −2.5 to −2
// and would make a refund and a charge of the same size round in opposite
// directions. The ROI percentage is rounded to a whole percent because a
// tenth of a percent on an estimate is false precision.
//
// CURRENCY: REFUSE, DO NOT GUESS. Converting between currencies needs a rate,
// a rate date and a source — none of which this module has, and all of which
// would have to be invented to produce a number. So a window containing more
// than one currency returns a typed error and the screen says so.

// ── Catalogue (in code, not the DB) ──────────────────────────────────────────
// Same rule as src/lib/orgPlans.ts: what the categories ARE and what the
// default assumptions are ship with a deploy, not with a migration. The DB
// stores the tenant's numbers; this file stores the model.

export const PROGRAM_COST_CATEGORIES = ['PLATFORM', 'STAFF', 'MENTOR_TIME', 'EVENT', 'OTHER'] as const;
export type ProgramCostCategory = (typeof PROGRAM_COST_CATEGORIES)[number];

export function isProgramCostCategory(value: unknown): value is ProgramCostCategory {
  return typeof value === 'string' && (PROGRAM_COST_CATEGORIES as readonly string[]).includes(value);
}

/** Where a placement's recorded value came from. See Placement.valueSource. */
export const PLACEMENT_VALUE_SOURCES = ['OFFER_COMP', 'MANUAL', 'ORG_DEFAULT'] as const;
export type PlacementValueSource = (typeof PLACEMENT_VALUE_SOURCES)[number];

export function isPlacementValueSource(value: unknown): value is PlacementValueSource {
  return typeof value === 'string' && (PLACEMENT_VALUE_SOURCES as readonly string[]).includes(value);
}

/**
 * What the model assumes when the data does not say.
 *
 * EVERY NUMBER HERE IS AN ASSUMPTION AND IS LABELLED AS ONE. The result
 * reports how many placements it had to assume a value for (`assumedPlacements`)
 * precisely so an estimate can never be read as a measurement. An org overrides
 * any subset of these; what is not overridden falls back to the values below.
 */
export interface RoiAssumptions {
  /** ISO 4217 code these assumptions are denominated in. */
  currency: string;
  /**
   * What a junior role costs the business for each month it sits unfilled —
   * the output nobody produced plus the time the rest of the team spent
   * covering. €4 500/month is a deliberately conservative figure for a junior
   * position in DE/TR; it is well below the "1× salary" rule of thumb that
   * recruitment vendors quote, because this number has to survive a CFO
   * reading it.
   */
  unfilledRoleCostPerMonthMinor: number;
  /**
   * How many months of vacancy one placement avoids. Two months is the gap
   * between "we have a candidate we already know" and a cold search; it is not
   * a claim that every role would otherwise have stayed open forever.
   */
  vacancyMonthsAvoidedPerPlacement: number;
  /**
   * The agency fee not paid because the hire came through the programme.
   * €9 000 ≈ 20% of a €45 000 junior salary, the usual contingency rate.
   */
  recruiterFeeAvoidedPerPlacementMinor: number;
  /**
   * What one hour of a senior mentor's time is worth. Used only to price
   * mentor hours that are NOT invoiced, so that a programme run on donated
   * time does not appear to be free — it appears to be paid for in a currency
   * the ledger does not see.
   */
  mentorHourValueMinor: number;
}

export const DEFAULT_ASSUMPTIONS: RoiAssumptions = {
  currency: 'EUR',
  unfilledRoleCostPerMonthMinor: 450_000, // €4,500.00
  vacancyMonthsAvoidedPerPlacement: 2,
  recruiterFeeAvoidedPerPlacementMinor: 900_000, // €9,000.00
  mentorHourValueMinor: 6_000, // €60.00
};

// ── Input ────────────────────────────────────────────────────────────────────

export interface RoiCostInput {
  /** One of PROGRAM_COST_CATEGORIES, or a tenant's own key — unused by the
   *  arithmetic (all costs are additive) and carried only so the UI can break
   *  the total down. */
  category?: string;
  /** Minor units. May be negative: a correction or refund is a negative line. */
  amountMinor: number;
  currency: string;
}

export interface RoiPlacementInput {
  /**
   * The relation's kind (#1503). A COACHING relation is NEVER a placement —
   * counting coaching as a hire inflates `placementCount`, which is the
   * denominator of cost-per-placement, so the error makes the programme look
   * cheaper than it is. Undefined is treated as a placement: the column does
   * not exist yet, and every relation that reaches the hired stage today is
   * one.
   */
  relationKind?: 'PLACEMENT' | 'COACHING' | null;
  /** Recorded value in minor units, or null/undefined for "not recorded". */
  valueMinor?: number | null;
  valueCurrency?: string | null;
  /** The success fee charged for this placement, if the org bills that way. */
  feeMinor?: number | null;
  feeCurrency?: string | null;
}

/** Carried through to the result for labelling. Never used in the arithmetic:
 *  selecting which costs and placements fall inside the window is the caller's
 *  query, not this module's job — that is what keeps the module clock-free. */
export interface RoiWindow {
  startIso: string;
  endIso: string;
}

export interface RoiInput {
  costs: RoiCostInput[];
  placements: RoiPlacementInput[];
  /** Any subset; the rest comes from DEFAULT_ASSUMPTIONS. */
  assumptions?: Partial<RoiAssumptions>;
  /**
   * Unbilled mentor hours in the window, priced with `mentorHourValueMinor`
   * and added to the COST side. Omit (or 0) when the org does not price
   * donated mentor time — the default, because charging a programme for hours
   * nobody paid for is a choice, not a fact.
   */
  mentorHours?: number;
  window?: RoiWindow;
}

// ── Result ───────────────────────────────────────────────────────────────────

export type RoiStepKey =
  | 'programCost'
  | 'mentorTimeCost'
  | 'totalCost'
  | 'placements'
  | 'recordedValue'
  | 'assumedValue'
  | 'realisedValue'
  | 'successFee'
  | 'costPerPlacement'
  | 'net'
  | 'roiPercent';

/**
 * One line of the show-your-working panel. `expression` is the arithmetic in
 * plain ASCII (`"1200000 - 450000"`), deliberately NOT localised: it is the
 * calculation, and the reader's label for the step comes from the `roi.steps`
 * i18n block keyed by `key`.
 */
export interface RoiStep {
  key: RoiStepKey;
  expression: string;
  /** Minor units, or null for a step that is not money (a count, a percentage). */
  valueMinor: number | null;
  count?: number;
  percent?: number | null;
}

export interface RoiFigures {
  ok: true;
  currency: string;
  window: RoiWindow | null;
  assumptions: RoiAssumptions;

  /** Sum of the cost lines. */
  programCostMinor: number;
  /** Priced mentor hours, 0 when none were given. */
  mentorTimeCostMinor: number;
  totalCostMinor: number;

  /** Placements after coaching relations are excluded. */
  placementCount: number;
  /** ... of which carried a recorded value, and ... */
  valuedPlacements: number;
  /** ... of which had to fall back to the assumption set. Read them together:
   *  a result where `assumedPlacements` is most of `placementCount` is an
   *  estimate wearing a measurement's clothes, and the UI must say so. */
  assumedPlacements: number;

  recordedValueMinor: number;
  assumedValueMinor: number;
  realisedValueMinor: number;

  /**
   * Success fees charged for these placements. Reported, never added to
   * `realisedValueMinor`: the fee is revenue to the programme and a cost to
   * the client, so folding it into the same total double-counts one hire.
   */
  successFeeMinor: number;

  /** null when there were no placements — 0 placements has no cost each. */
  costPerPlacementMinor: number | null;
  netMinor: number;
  /** null when the cost side is zero: "infinite return" is not a number. */
  roiPercent: number | null;

  steps: RoiStep[];
}

export type RoiError =
  | { ok: false; error: 'mixed_currency'; currencies: string[] }
  | { ok: false; error: 'invalid_currency'; currencies: string[] }
  | { ok: false; error: 'invalid_amount'; field: string };

export type RoiResult = RoiFigures | RoiError;

// ── Arithmetic helpers ───────────────────────────────────────────────────────

/**
 * Round to whole minor units, HALF AWAY FROM ZERO.
 *
 * `Math.round(-2.5)` is -2: half-up in the positive direction only. That makes
 * a −2.5 refund and a +2.5 charge round by different amounts, so a ledger of
 * matched pairs no longer sums to zero. This is the only rounding money passes
 * through in this module.
 */
export function roundMinor(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function normaliseCurrency(code: string): string {
  return code.trim().toUpperCase();
}

const CURRENCY_RE = /^[A-Z]{3}$/;

// ── The calculation ──────────────────────────────────────────────────────────

/**
 * Compute the ROI figures for one window.
 *
 * Returns a discriminated union rather than throwing: a public calculator feeds
 * this numbers a visitor typed, and a thrown exception there is a blank screen
 * where an explanation belongs.
 */
export function computeRoi(input: RoiInput): RoiResult {
  const assumptions: RoiAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };

  // 1. Every money value must be an integer before anything is added up. A
  //    single 12.5 here is how a float total gets in.
  for (const [field, value] of [
    ['assumptions.unfilledRoleCostPerMonthMinor', assumptions.unfilledRoleCostPerMonthMinor],
    ['assumptions.recruiterFeeAvoidedPerPlacementMinor', assumptions.recruiterFeeAvoidedPerPlacementMinor],
    ['assumptions.mentorHourValueMinor', assumptions.mentorHourValueMinor],
  ] as const) {
    if (!isMoney(value)) return { ok: false, error: 'invalid_amount', field };
  }
  if (
    typeof assumptions.vacancyMonthsAvoidedPerPlacement !== 'number' ||
    !Number.isFinite(assumptions.vacancyMonthsAvoidedPerPlacement) ||
    assumptions.vacancyMonthsAvoidedPerPlacement < 0
  ) {
    return { ok: false, error: 'invalid_amount', field: 'assumptions.vacancyMonthsAvoidedPerPlacement' };
  }

  const mentorHours = input.mentorHours ?? 0;
  if (typeof mentorHours !== 'number' || !Number.isFinite(mentorHours) || mentorHours < 0) {
    return { ok: false, error: 'invalid_amount', field: 'mentorHours' };
  }

  // 2. Collect every currency that actually carries an amount. A null value
  //    with a stray currency code must not trip the mixed-currency rule — the
  //    row contributes nothing, so its label is noise.
  const currencies = new Set<string>();
  const malformed = new Set<string>();
  const note = (raw: string | null | undefined) => {
    if (raw == null) return;
    const code = normaliseCurrency(raw);
    if (!CURRENCY_RE.test(code)) malformed.add(raw);
    else currencies.add(code);
  };
  note(assumptions.currency);

  for (let i = 0; i < input.costs.length; i++) {
    const cost = input.costs[i];
    if (!isMoney(cost.amountMinor)) return { ok: false, error: 'invalid_amount', field: `costs[${i}].amountMinor` };
    note(cost.currency);
  }
  for (let i = 0; i < input.placements.length; i++) {
    const placement = input.placements[i];
    if (placement.valueMinor != null) {
      if (!isMoney(placement.valueMinor)) return { ok: false, error: 'invalid_amount', field: `placements[${i}].valueMinor` };
      note(placement.valueCurrency ?? assumptions.currency);
    }
    if (placement.feeMinor != null) {
      if (!isMoney(placement.feeMinor)) return { ok: false, error: 'invalid_amount', field: `placements[${i}].feeMinor` };
      note(placement.feeCurrency ?? assumptions.currency);
    }
  }

  if (malformed.size > 0) return { ok: false, error: 'invalid_currency', currencies: [...malformed].sort() };
  if (currencies.size > 1) return { ok: false, error: 'mixed_currency', currencies: [...currencies].sort() };
  // `currencies` always holds at least the assumption currency, so the fallback
  // below is unreachable in practice and exists only to keep the type honest.
  const currency = currencies.values().next().value ?? normaliseCurrency(DEFAULT_ASSUMPTIONS.currency);

  // 3. Cost side. Additive by construction: the total is the sum of the lines
  //    and nothing else, so correcting a figure means editing one row.
  let programCostMinor = 0;
  for (const cost of input.costs) programCostMinor += cost.amountMinor;

  const mentorTimeCostMinor = roundMinor(mentorHours * assumptions.mentorHourValueMinor);
  const totalCostMinor = programCostMinor + mentorTimeCostMinor;

  // 4. Value side. Coaching relations are not placements (#1503/#1504).
  const counted = input.placements.filter((p) => p.relationKind !== 'COACHING');
  const placementCount = counted.length;

  const assumedPerPlacementMinor =
    assumptions.recruiterFeeAvoidedPerPlacementMinor +
    roundMinor(assumptions.vacancyMonthsAvoidedPerPlacement * assumptions.unfilledRoleCostPerMonthMinor);

  let recordedValueMinor = 0;
  let valuedPlacements = 0;
  let successFeeMinor = 0;
  for (const placement of counted) {
    if (placement.valueMinor != null) {
      recordedValueMinor += placement.valueMinor;
      valuedPlacements += 1;
    }
    if (placement.feeMinor != null) successFeeMinor += placement.feeMinor;
  }
  const assumedPlacements = placementCount - valuedPlacements;
  const assumedValueMinor = assumedPlacements * assumedPerPlacementMinor;
  const realisedValueMinor = recordedValueMinor + assumedValueMinor;

  // 5. The two divisions, each rounded exactly once.
  const costPerPlacementMinor = placementCount === 0 ? null : roundMinor(totalCostMinor / placementCount);
  const netMinor = realisedValueMinor - totalCostMinor;
  const roiPercent = totalCostMinor === 0 ? null : roundMinor((netMinor / totalCostMinor) * 100);

  const steps: RoiStep[] = [
    {
      key: 'programCost',
      expression: `sum(${input.costs.length} cost lines) = ${programCostMinor}`,
      valueMinor: programCostMinor,
      count: input.costs.length,
    },
    {
      key: 'mentorTimeCost',
      expression: `${mentorHours} h x ${assumptions.mentorHourValueMinor} = ${mentorTimeCostMinor}`,
      valueMinor: mentorTimeCostMinor,
      count: mentorHours,
    },
    {
      key: 'totalCost',
      expression: `${programCostMinor} + ${mentorTimeCostMinor} = ${totalCostMinor}`,
      valueMinor: totalCostMinor,
    },
    {
      key: 'placements',
      expression: `${input.placements.length} relations - ${input.placements.length - placementCount} coaching = ${placementCount}`,
      valueMinor: null,
      count: placementCount,
    },
    {
      key: 'recordedValue',
      expression: `sum(${valuedPlacements} recorded placement values) = ${recordedValueMinor}`,
      valueMinor: recordedValueMinor,
      count: valuedPlacements,
    },
    {
      key: 'assumedValue',
      expression: `${assumedPlacements} x ${assumedPerPlacementMinor} = ${assumedValueMinor}`,
      valueMinor: assumedValueMinor,
      count: assumedPlacements,
    },
    {
      key: 'realisedValue',
      expression: `${recordedValueMinor} + ${assumedValueMinor} = ${realisedValueMinor}`,
      valueMinor: realisedValueMinor,
    },
    {
      key: 'successFee',
      expression: `sum(success fees) = ${successFeeMinor} (reported, not added to value)`,
      valueMinor: successFeeMinor,
    },
    {
      key: 'costPerPlacement',
      expression:
        costPerPlacementMinor === null
          ? `${totalCostMinor} / 0 placements = n/a`
          : `${totalCostMinor} / ${placementCount} = ${costPerPlacementMinor}`,
      valueMinor: costPerPlacementMinor,
    },
    {
      key: 'net',
      expression: `${realisedValueMinor} - ${totalCostMinor} = ${netMinor}`,
      valueMinor: netMinor,
    },
    {
      key: 'roiPercent',
      expression:
        roiPercent === null ? `${netMinor} / 0 cost = n/a` : `${netMinor} / ${totalCostMinor} x 100 = ${roiPercent}`,
      valueMinor: null,
      percent: roiPercent,
    },
  ];

  return {
    ok: true,
    currency,
    window: input.window ?? null,
    assumptions: { ...assumptions, currency },
    programCostMinor,
    mentorTimeCostMinor,
    totalCostMinor,
    placementCount,
    valuedPlacements,
    assumedPlacements,
    recordedValueMinor,
    assumedValueMinor,
    realisedValueMinor,
    successFeeMinor,
    costPerPlacementMinor,
    netMinor,
    roiPercent,
    steps,
  };
}

/**
 * Minor units → a display string, on the reader's locale.
 *
 * Presentation only — never feed its output back into the arithmetic. The
 * number of decimals comes from the currency itself (`Intl` knows JPY has
 * none), which is the whole reason the storage unit is "minor" rather than
 * "cents".
 */
export function formatMinor(amountMinor: number, currency: string, locale: string): string {
  const code = normaliseCurrency(currency);
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: CURRENCY_RE.test(code) ? code : 'EUR' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}
