// The SaleVali event envelope, as the CRM validates it (#2450) — field for field
// docs/marketing-vertical/salevali-provider-contract.md § Olay zarfı. Unknown
// keys are dropped (`strip`), so SaleVali adding a field never breaks the feed;
// a schema_version other than 1 is refused, so a CHANGED meaning never slips in.
import { z } from 'zod';
import {
  EXTERNAL_ID_PATTERN,
  SALEVALI_ACQUISITION_SOURCES,
  SALEVALI_EVENT_TYPES,
} from '@/lib/salevaliIngestRule';

const isoDate = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const nullableIsoDate = isoDate.nullable().optional().transform((v) => v ?? null);
const shortText = (max: number) => z.string().trim().max(max).nullable().optional();

export const saleValiEventSchema = z.object({
  event_id: z.string().regex(/^[0-9a-f]{24}$/i),
  schema_version: z.literal(1),
  event_type: z.enum(SALEVALI_EVENT_TYPES),
  occurred_at: isoDate,
  external_id: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(EXTERNAL_ID_PATTERN)),
  license_type: shortText(40),
  status: shortText(40),
  trial_started_at: nullableIsoDate,
  trial_ends_at: nullableIsoDate,
  decision_ends_at: nullableIsoDate,
  acquisition_source: z.enum(SALEVALI_ACQUISITION_SOURCES).nullable().optional(),
  reference: shortText(64),
  // NEVER a marketing permission (#2577): accepted so a SaleVali payload that
  // still carries its pre-ticked newsletter flag validates, and then ignored.
  newsletter: z.boolean().nullable().optional(),
  contact: z
    .object({
      name: shortText(191),
      surname: shortText(191),
      email: z.string().trim().email().max(191).nullable().optional(),
      company_name: shortText(191),
    })
    .nullable()
    .optional(),
});

export type SaleValiEvent = z.output<typeof saleValiEventSchema>;
