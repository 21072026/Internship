// A pre-rendered mail (#1711) rides a queue row — the `notification.email` job,
// or a `notification.deferred` job held for quiet hours. The subject and body
// carry personal data, so the row keeps only a sealed blob (AES-256-GCM,
// src/lib/secretBox.ts), the same rule the mail outbox follows for its envelopes.
// A blob that will not open (secret rotated, row copied between environments)
// is a FAILED delivery, never a send of something else.
import { open, seal } from '@/lib/secretBox';
import type { PrerenderedEmail } from './adapters/types';

const PURPOSE = 'notification-email';

export function sealEmail(mail: PrerenderedEmail): string {
  return seal(JSON.stringify(mail), PURPOSE);
}

export function openEmail(sealed: string): PrerenderedEmail | null {
  const raw = open(sealed, PURPOSE);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as PrerenderedEmail;
    return typeof m?.subject === 'string' && typeof m?.html === 'string' && typeof m?.category === 'string' ? m : null;
  } catch {
    return null;
  }
}
