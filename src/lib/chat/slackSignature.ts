import { createHmac } from 'crypto';
import { safeEqual } from '@/lib/secretBox';

/**
 * Slack's request signature (https://api.slack.com/authentication/verifying-requests-from-slack):
 * `v0=` + HMAC-SHA256(signing secret, `v0:<timestamp>:<raw body>`), with the
 * timestamp no more than five minutes from now so a captured request cannot be
 * replayed later. Pure: the uninstall webhook (#1935) hands it the raw body.
 */
export const SLACK_SIGNATURE_MAX_SKEW_S = 5 * 60;

export function slackSignatureFor(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

export function verifySlackSignature(input: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowS?: number;
}): boolean {
  if (!input.secret || !input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  const now = input.nowS ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > SLACK_SIGNATURE_MAX_SKEW_S) return false;
  return safeEqual(input.signature, slackSignatureFor(input.secret, input.timestamp, input.rawBody));
}
