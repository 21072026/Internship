import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

/**
 * Authenticated encryption at rest, for the few secrets this app must be able
 * to READ BACK rather than merely verify (#709: Google OAuth refresh tokens).
 *
 * Everything else stored sensitively here is hashed or HMAC'd, because for
 * passwords and evidence records one-way is not just enough — it is safer. A
 * refresh token is different: it has to leave the database usable, so it needs
 * encryption, not hashing, and the difference is worth being explicit about.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt instead of quietly
 * yielding garbage. The key is derived from NEXTAUTH_SECRET through HKDF with a
 * per-purpose label, so a secret already used for signing never doubles as an
 * encryption key directly, and two purposes never share a key.
 *
 * This does NOT protect against an attacker who has both the database and the
 * server env — nothing short of a KMS/HSM does. What it buys is that a database
 * dump, a stray backup, or a read-only SQL injection yields no usable tokens.
 */

const VERSION = 'v1';

function keyFor(purpose: string): Buffer {
  // HKDF with the purpose as `info`: same master secret, independent keys.
  // The salt is fixed on purpose — the master secret is already high-entropy,
  // and a random salt would have to be stored next to every ciphertext.
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(requireServerSecret(), 'utf8'), Buffer.from('internship-crm-secretbox'), Buffer.from(purpose), 32)
  );
}

/** Encrypt a string for storage. Returns `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function seal(plaintext: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * Decrypt a sealed string, or return null.
 *
 * Null rather than throw: a token that cannot be decrypted (secret rotated,
 * row copied between environments, value corrupted) means "this connection is
 * no longer usable", and the caller's answer to that is to ask the person to
 * reconnect — not to 500 on a calendar sync.
 */
export function open(sealed: string, purpose: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Constant-time compare for opaque tokens (state nonces, revocation checks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
