import { test, expect } from '@playwright/test';
import { buildSecurityTxt, securityContactEmail } from '@/lib/securityTxt';

// The security.txt builder (#2031) — no browser, no server. The served route is
// covered by e2e/security-txt.spec.ts; this pins the contact rules a deployment
// configures through its env, where a mistake is invisible until a researcher
// tries to write in.

test('a dedicated security address wins over the operator address', { tag: '@smoke' }, async () => {
  expect(securityContactEmail({ SECURITY_CONTACT_EMAIL: 'sec@example.test' }, 'hello@example.test')).toBe('sec@example.test');
  expect(securityContactEmail({}, 'hello@example.test')).toBe('hello@example.test');
  expect(securityContactEmail({}, null)).toBeNull();
});

test('an address that could forge a field is never printed', { tag: '@smoke' }, async () => {
  expect(securityContactEmail({ SECURITY_CONTACT_EMAIL: 'a@b.test\nPolicy: https://evil.test' }, null)).toBeNull();
  expect(securityContactEmail({}, 'not an address')).toBeNull();
  // A bad override falls through to the operator address rather than to nothing.
  expect(securityContactEmail({ SECURITY_CONTACT_EMAIL: 'x y@z' }, 'hello@example.test')).toBe('hello@example.test');
});

test('the GitHub form stays the preferred contact; the mailto follows it', { tag: '@smoke' }, async () => {
  const contacts = (body: string) => body.split('\n').filter((l) => l.startsWith('Contact: '));
  expect(contacts(buildSecurityTxt('sec@example.test'))).toEqual([
    'Contact: https://github.com/21072026/Internship/security/advisories/new',
    'Contact: mailto:sec@example.test',
  ]);
  expect(contacts(buildSecurityTxt(null))).toHaveLength(1);
});
