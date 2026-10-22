// When an IdP signing certificate is worth a word (#1933). Pure and
// dependency-free: the admin card's badge, the save-time refusal and the
// expiry-warning job all read their thresholds from here.
//
// TWO MAILS, NOT A NAG. A certificate that lapses takes every SSO login of the
// tenant with it, so its admins hear about it twice — 30 days out and 7 days
// out — and never daily. What has been sent is persisted on the organization
// (`ssoCertWarnFingerprint` + `ssoCertWarnStage`), keyed to the certificate's
// SHA-256 fingerprint, so a redeploy (which restarts the cron) never re-sends,
// and a NEW certificate — another fingerprint — starts the count afresh.

/** The warning marks, furthest first. Each is mailed at most once per certificate. */
export const CERT_WARN_STAGES = [30, 7] as const;
export type CertWarnStage = (typeof CERT_WARN_STAGES)[number];

/** The badge's "expires soon" threshold — the first warning mark. */
export const CERT_EXPIRING_DAYS = CERT_WARN_STAGES[0];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left, rounded down; negative once expired. */
export function daysUntil(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
}

export type CertificateStatus = 'valid' | 'expiring' | 'expired';

export function certificateStatus(notAfter: Date, now: Date): { status: CertificateStatus; daysLeft: number } {
  const daysLeft = daysUntil(notAfter, now);
  if (notAfter.getTime() <= now.getTime()) return { status: 'expired', daysLeft };
  return { status: daysLeft <= CERT_EXPIRING_DAYS ? 'expiring' : 'valid', daysLeft };
}

export interface SentWarning {
  fingerprint: string | null;
  stage: number | null;
}

/**
 * The warning mark due now, or null. The closest mark the certificate has
 * reached wins, so a certificate first seen at 5 days gets the 7-day mail only
 * (one mail, not two at once), and an expired certificate gets none — the
 * integration-health row reports it, and a "will expire" mail would be a lie.
 */
export function dueWarningStage(input: {
  daysLeft: number;
  fingerprint: string;
  sent: SentWarning;
}): CertWarnStage | null {
  if (input.daysLeft < 0) return null;
  const reached = [...CERT_WARN_STAGES].reverse().find((s) => input.daysLeft <= s);
  if (reached === undefined) return null;
  const sameCert = input.sent.fingerprint === input.fingerprint;
  if (sameCert && input.sent.stage !== null && input.sent.stage <= reached) return null;
  return reached;
}
