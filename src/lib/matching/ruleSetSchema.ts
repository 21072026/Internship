/**
 * The shape a rule set may be written in (#1783) — one zod schema shared by
 * the save routes and the simulation, so a draft that simulates is a draft
 * that saves. Client-safe.
 *
 * Unlike the scorer (which reads an unknown dimension as a non-match so an
 * older bundle never crashes), a WRITE refuses a dimension the registry does
 * not know: nobody should be able to save a rule that can only ever fail.
 */

import { z } from 'zod';
import { MATCH_DIMENSIONS } from './types';

export const MATCH_RULE_LIMIT = 20;

const configSchema = z
  .object({
    // timezone: the widest gap, in hours, that still counts as a match.
    maxHours: z.number().min(0).max(14).optional(),
    // skills: how many shared skills count as a match.
    minShared: z.number().int().min(1).max(40).optional(),
    // skills: 'lowercase' is the pre-#1781 comparison; 'normalized' the default.
    mode: z.enum(['normalized', 'lowercase']).optional(),
    // capacityHeadroom: also refuse a mentor who switched acceptingMentees off.
    honourPreference: z.boolean().optional(),
    // capacityHeadroom: a self-select round — honour each mentor's selfMatchLimit (#1808).
    selfSelect: z.boolean().optional(),
  })
  .strict();

export const matchRuleSchema = z.object({
  dimension: z.enum(MATCH_DIMENSIONS),
  kind: z.enum(['WEIGHTED', 'HARD_REQUIRE', 'HARD_EXCLUDE']),
  weight: z.number().int().min(0).max(100),
  config: configSchema.default({}),
});

export const matchRuleSetDraftSchema = z.object({
  name: z.string().trim().min(1).max(191),
  description: z.string().trim().max(2000).optional().nullable(),
  rules: z.array(matchRuleSchema).max(MATCH_RULE_LIMIT),
});

export type MatchRuleDraft = z.infer<typeof matchRuleSchema>;
export type MatchRuleSetDraft = z.infer<typeof matchRuleSetDraftSchema>;
