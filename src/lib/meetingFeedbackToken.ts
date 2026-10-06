import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

// Signed one-click links for the "how was the meeting?" e-mail (#1896). The
// same construction and trust argument as src/lib/emailActionToken.ts — the
// link only ever goes to that user's registered address — with its own HMAC
// domain, so a meeting-feedback token can never be replayed as a reaction or a
// read receipt, nor the other way round.
//
// The rating is IN the token (0 = "we didn't meet", 1–5 = helpfulness), so
// each button in the mail is its own signed link and the page it opens only
// has to confirm it. The page performs the write from the browser: mail
// scanners prefetch every URL, and a mutating GET would record ratings nobody
// gave (the emailActionToken reasoning).

export const MEETING_FEEDBACK_TTL_DAYS = 30;
/** 0 means "the meeting did not take place". */
export const DID_NOT_MEET = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / DAY_MS);
const SEP = '~';
const DOMAIN = 'meeting-feedback:';

export interface MeetingFeedbackAction {
  meetingId: string;
  userId: string;
  /** 0 = did not meet, 1..5 = helpfulness. */
  rating: number;
}

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(DOMAIN + payload).digest('hex').slice(0, 32);
}

export function makeMeetingFeedbackToken(a: MeetingFeedbackAction, day: number = today()): string {
  const payload = ['f', a.meetingId, a.userId, String(a.rating), day.toString(36)].join(SEP);
  return `${payload}.${sign(payload)}`;
}

/** null when it does not verify; 'expired' when genuine but too old. */
export function verifyMeetingFeedbackToken(token: string): MeetingFeedbackAction | 'expired' | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const parts = payload.split(SEP);
  if (parts.length !== 5 || parts[0] !== 'f') return null;
  const [, meetingId, userId, rawRating, stamp] = parts;
  const rating = Number(rawRating);
  if (!meetingId || !userId || !Number.isInteger(rating) || rating < 0 || rating > 5) return null;
  const issued = parseInt(stamp, 36);
  if (!Number.isFinite(issued) || today() - issued > MEETING_FEEDBACK_TTL_DAYS) return 'expired';
  return { meetingId, userId, rating };
}

export function meetingFeedbackUrl(a: MeetingFeedbackAction, origin?: string | null): string {
  const base = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${base}/meeting-feedback/${encodeURIComponent(makeMeetingFeedbackToken(a))}`;
}
