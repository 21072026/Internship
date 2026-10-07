// The request-body half of structured compensation (#1851): the zod shape the
// offer routes share and the merge that turns a PATCH into a full field set.
// src/lib/compensation.ts holds the rules and stays zod-free so the unit test
// and the client bundle import nothing they do not need.
import { z } from 'zod';
import {
  EMPTY_COMPENSATION,
  EQUITY_NOTE_MAX,
  MAX_AMOUNT_MINOR,
  MAX_HOURS_PER_WEEK,
  type CompensationFields,
} from '@/lib/compensation';

const amount = z.number().int().min(0).max(MAX_AMOUNT_MINOR).nullable().optional();

/** Spread into a route's `z.object({...})`. Every field optional: absent means
 * "unchanged" on PATCH and "unset" on POST; `null` clears it. */
export const compensationInputShape = {
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).nullable().optional(),
  baseAmountMinor: amount,
  basePeriod: z.string().trim().max(10).nullable().optional(),
  signingBonusMinor: amount,
  otherBonusMinor: amount,
  equityNote: z.string().trim().max(EQUITY_NOTE_MAX).nullable().optional(),
  hoursPerWeek: z.number().int().min(1).max(MAX_HOURS_PER_WEEK).nullable().optional(),
  contractType: z.string().trim().max(20).nullable().optional(),
};

export type CompensationInput = Partial<{ [K in keyof CompensationFields]: CompensationFields[K] | undefined }>;

/** Only the compensation keys of a parsed body, with `undefined` kept as "not sent". */
export function pickCompensationInput(body: CompensationInput): CompensationInput {
  const out: CompensationInput = {};
  for (const key of Object.keys(EMPTY_COMPENSATION) as (keyof CompensationFields)[]) {
    if (body[key] !== undefined) {
      // An empty string is a cleared field, never a stored value.
      const value = body[key];
      (out as unknown as Record<string, unknown>)[key] = typeof value === 'string' && value === '' ? null : value;
    }
  }
  return out;
}

/** Apply a PATCH to the stored fields: sent keys win, absent keys stay. */
export function mergeCompensation(current: CompensationFields, patch: CompensationInput): CompensationFields {
  const merged: CompensationFields = { ...current };
  for (const key of Object.keys(EMPTY_COMPENSATION) as (keyof CompensationFields)[]) {
    if (patch[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = patch[key];
  }
  return merged;
}
