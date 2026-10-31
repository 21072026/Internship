// The domain-proof fast path of employer verification (#1865) — server-only.
// The pure half (record shape, TXT matching) is in src/lib/companySignup.ts.
//
// The token is an HMAC of the company id under the deployment's secret: stable
// (the company can publish it once), unguessable, and nothing to store or leak.
// The lookup is a DNS TXT query on the domain the company signed up with, never
// a domain the request names, so the check cannot be pointed anywhere else.

import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import { domainProofRecord, txtRecordsContain } from '@/lib/companySignup';

const LOOKUP_TIMEOUT_MS = 5000;

function secret(): string {
  const value = process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error('NEXTAUTH_SECRET is not set');
  return value;
}

export function domainProofToken(companyId: string): string {
  return crypto.createHmac('sha256', secret()).update(`company-domain-proof:${companyId}`).digest('hex').slice(0, 32);
}

export function expectedDomainProofRecord(companyId: string): string {
  return domainProofRecord(domainProofToken(companyId));
}

/** True when the domain publishes the company's record. A failed or slow lookup is false, never an error. */
export async function domainPublishesProof(domain: string, companyId: string): Promise<boolean> {
  const expected = expectedDomainProofRecord(companyId);
  try {
    const records = await Promise.race([
      dns.resolveTxt(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS)),
    ]);
    return txtRecordsContain(records, expected);
  } catch {
    return false;
  }
}
