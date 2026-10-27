// The account-event envelope, as the CRM validates it (#2450, generic since
// #2914) — field for field docs/integrations/account-events.md § Envelope.
// Unknown keys are dropped (`strip`), so a sender adding a field never breaks
// the feed; a schema_version other than 1 is refused, so a CHANGED meaning
// never slips in. No field of the envelope is ever a marketing permission
// (#2577): a new account gets the machine NONE row and nothing else.
import { z } from 'zod';
import { normalizePlanKey } from '@/lib/usageRule';
import {
  ACCOUNT_ACQUISITION_SOURCES,
  ACCOUNT_EVENT_SCHEMA_VERSION,
  ACCOUNT_EVENT_TYPES,
  EVENT_ID_PATTERN,
  EXTERNAL_ID_MAX,
  normalizeExternalId,
} from '@/lib/accountEventRule';

const isoDate = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const nullableIsoDate = isoDate.nullable().optional().transform((v) => v ?? null);
const shortText = (max: number) => z.string().trim().max(max).nullable().optional();

export const accountEventSchema = z.object({
  event_id: z
    .string()
    .regex(EVENT_ID_PATTERN, 'event_id: 1–64 characters of A–Z a–z 0–9 . _ : -')
    .transform((v) => v.toLowerCase()),
  schema_version: z.literal(ACCOUNT_EVENT_SCHEMA_VERSION),
  event_type: z.enum(ACCOUNT_EVENT_TYPES),
  occurred_at: isoDate,
  // Historic mode (docs/integrations/account-events.md § Historic mode): the
  // sender marks a replay of its own past. Optional and additive — an event
  // older than HISTORIC_EVENT_AGE_DAYS is historic without it.
  replay: z.boolean().nullable().optional(),
  external_id: z
    .string()
    .transform((v, ctx) => {
      const id = normalizeExternalId(v);
      if (id === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `external_id: 1–${EXTERNAL_ID_MAX} characters of printable ASCII after trimming`,
        });
        return z.NEVER;
      }
      return id;
    }),
  trial_started_at: nullableIsoDate,
  trial_ends_at: nullableIsoDate,
  // Accepted and validated, not stored: nothing reads a decision window yet.
  decision_ends_at: nullableIsoDate,
  acquisition_source: z.enum(ACCOUNT_ACQUISITION_SOURCES).nullable().optional(),
  referral_code: shortText(64),
  // The account's plan in the source product (#2846): stored on the account as
  // `productPlan`, `free` feeds the free-quota upsell signal. Any key the
  // source uses is accepted; a malformed one is refused, never guessed at.
  plan: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v.trim() === '') return null;
      const key = normalizePlanKey(v);
      if (key === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'plan: 1–40 characters of A–Z a–z 0–9 . _ -' });
        return z.NEVER;
      }
      return key;
    }),
  contact: z
    .object({
      first_name: shortText(191),
      last_name: shortText(191),
      email: z.string().trim().email().max(191).nullable().optional(),
      company_name: shortText(191),
    })
    .nullable()
    .optional(),
});

export type AccountEvent = z.output<typeof accountEventSchema>;
