import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guard for URLs the server will fetch on someone else's say-so (#893).
 *
 * A webhook URL is admin-supplied and then called *from the server's network
 * position*, which is a very different place from the admin's browser:
 * `http://127.0.0.1:3306` reaches the database, and
 * `http://169.254.169.254/latest/meta-data/` reaches the cloud metadata service
 * and, with it, instance credentials. `z.string().url()` accepted both.
 */

/** Hostnames that are never legitimate outbound targets, whatever they resolve to. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const BLOCKED_NAMES = ['localhost'];

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(v)) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1) — judge by the embedded address.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // not an address we can reason about — refuse
}

export class SsrfBlockedError extends Error {}

/**
 * Throws `SsrfBlockedError` unless `raw` is an https URL on a public address.
 *
 * The check is on the **resolved** addresses, not the hostname string: a name
 * an attacker controls can point at 127.0.0.1 just as easily as a literal can.
 * (This narrows DNS rebinding rather than eliminating it — the name is resolved
 * again by `fetch`, and a short TTL can return something different the second
 * time. Closing that fully means pinning the connection to the checked IP,
 * which `fetch` gives no hook for; it is a much smaller window than accepting
 * `http://169.254.169.254` outright.)
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Not a valid URL');
  }

  // https only: plaintext would send the payload — real business data, see
  // WEBHOOK_EVENTS — over the wire in the clear.
  if (url.protocol !== 'https:') {
    throw new SsrfBlockedError('Only https:// webhook URLs are allowed');
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('Credentials in the URL are not allowed');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_NAMES.includes(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfBlockedError('That host is not a permitted target');
  }

  // A literal address needs no DNS round-trip.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SsrfBlockedError('That address is not a permitted target');
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError('That host could not be resolved');
  }
  if (addresses.length === 0) throw new SsrfBlockedError('That host could not be resolved');
  // Every answer must be public: one private record among them is enough for a
  // resolver to hand `fetch` the internal one.
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new SsrfBlockedError('That host resolves to a private address');
    }
  }
  return url;
}
