// The subprocessor register, once (#2027).
//
// /trust renders in three locales. Keeping the list of third parties in the
// dictionary would mean maintaining thirteen rows three times, and a register
// that is wrong in German is a register nobody can rely on. So the *structure*
// lives here — which parties exist, which environment variables switch them on,
// how optional each one is — and only the prose is translated, keyed by the
// same ids.
//
// The prose lives in `trust.sub.<id>` in src/i18n/dictionaries.ts. `SubKey` is
// derived from that block, so adding a row here without translating it (or
// renaming a key in the dictionary) is a type error rather than a blank cell.
//
// The long-form register — with the reasoning behind each row — is
// docs/trust/subprocessors.md. The rule that adding an outbound integration
// must update both is written down in docs/trust/README.md.

import type { Dictionary } from '@/i18n/dictionaries';

/** Bump together with the "Last updated" line in docs/trust/subprocessors.md. */
export const SUBPROCESSORS_UPDATED = '2026-09-02';

/**
 * How much has to be true before this party receives anything.
 *
 * - `required`        — core flows do not work without it.
 * - `optional`        — inert until its environment variables are set.
 * - `optionalConsent` — configured *and* the individual person agreed.
 */
export type Optionality = 'required' | 'optional' | 'optionalConsent';

type SubKey = keyof Dictionary['trust']['sub'];

export interface SubprocessorRow {
  id: SubKey;
  /** Proper noun — deliberately not translated. */
  name: string;
  /** The variables in .env.example that turn this path on. Empty = always on. */
  env: string[];
  optionality: Optionality;
}

export const SUBPROCESSORS: SubprocessorRow[] = [
  { id: 'hosting', name: 'Plesk-managed server (operator)', env: ['DATABASE_URL'], optionality: 'required' },
  { id: 'smtpPrimary', name: 'Primary SMTP relay', env: ['SMTP_HOST', 'SMTP_USER', 'SMTP_FROM'], optionality: 'required' },
  { id: 'smtpBulk', name: 'Bulk SMTP relay', env: ['SMTP_BULK_HOST', 'SMTP_BULK_FROM'], optionality: 'optional' },
  { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], optionality: 'optionalConsent' },
  { id: 'googleCalendar', name: 'Google Calendar', env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CALENDAR_ENABLED'], optionality: 'optionalConsent' },
  { id: 'jaas', name: '8x8 JaaS', env: ['JAAS_APP_ID', 'JAAS_API_KEY_ID', 'JAAS_PRIVATE_KEY'], optionality: 'optional' },
  { id: 'jitsiPublic', name: 'meet.jit.si (8x8)', env: [], optionality: 'required' },
  { id: 'webPush', name: 'Browser push services', env: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], optionality: 'optionalConsent' },
  { id: 'plausible', name: 'Plausible Analytics', env: ['NEXT_PUBLIC_PLAUSIBLE_DOMAIN'], optionality: 'optionalConsent' },
  { id: 'posthog', name: 'PostHog', env: ['NEXT_PUBLIC_POSTHOG_KEY'], optionality: 'optionalConsent' },
  { id: 'ga4', name: 'Google Analytics 4', env: ['NEXT_PUBLIC_GA4_MEASUREMENT_ID'], optionality: 'optionalConsent' },
  { id: 'tawk', name: 'tawk.to', env: [], optionality: 'optionalConsent' },
  { id: 'github', name: 'GitHub Actions + ghcr.io', env: [], optionality: 'required' },
];

export interface ResolvedSubprocessor extends SubprocessorRow {
  purpose: string;
  data: string;
  location: string;
  basis: string;
  optionalityLabel: string;
}

/** The register with its prose resolved against one locale's dictionary. */
export function getSubprocessors(t: Dictionary): ResolvedSubprocessor[] {
  return SUBPROCESSORS.map((row) => ({
    ...row,
    ...t.trust.sub[row.id],
    optionalityLabel: t.trust.optionality[row.optionality],
  }));
}

/** The controls grid — same idea, keyed against `trust.controls`. */
export const CONTROL_KEYS = [
  'accessControl',
  'authentication',
  'consent',
  'backups',
  'supplyChain',
  'assurance',
] as const;

export type ControlKey = (typeof CONTROL_KEYS)[number];

/** The "what is not true yet" list. Order is deliberate: worst first. */
export const LIMITATION_KEYS = ['tenancy', 'sharedHost', 'certification', 'push'] as const;

export type LimitationKey = (typeof LIMITATION_KEYS)[number];
