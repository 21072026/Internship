// Unit tests for the parts of a mail that must stay in its recipient's WORLD
// (docs/worlds.md): the From display name, the List-Id namespace and the accent
// a tenant left unset — pure node, no browser, no database.
//
// Same reason as e2e/email-groups-footer.unit.spec.ts for testing the builders
// directly: the Playwright config blanks SMTP_USER, so sendEmail() never builds
// a MIME part in any environment a test can reach.
import { test, expect } from '@playwright/test';
import { __testable } from '@/services/emailService';
import { mailAccentFor, ACCENT_SWATCH } from '@/lib/accent';

process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';

const { fromIdentity, unsubscribeHeaders } = __testable;

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test.describe('From display name', () => {
  test('a bare SMTP_FROM takes the brand, else the configured default', () => {
    withEnv({ SMTP_FROM: 'noreply@example.test', MAIL_FROM_NAME: 'Internship CRM' }, () => {
      expect(fromIdentity('SaleVali')).toEqual({ name: 'SaleVali', address: 'noreply@example.test' });
      expect(fromIdentity(null)).toEqual({ name: 'Internship CRM', address: 'noreply@example.test' });
    });
  });

  test('a name written into SMTP_FROM is only the default — a brand still wins', () => {
    // It used to be returned verbatim, which dropped every tenant's brand name:
    // on such a deployment a SaleVali reader got the internship name on all mail.
    withEnv({ SMTP_FROM: '"Internship CRM" <noreply@example.test>', MAIL_FROM_NAME: undefined }, () => {
      expect(fromIdentity('SaleVali')).toEqual({ name: 'SaleVali', address: 'noreply@example.test' });
      expect(fromIdentity(null)).toEqual({ name: 'Internship CRM', address: 'noreply@example.test' });
    });
    withEnv({ SMTP_FROM: 'Ops Team <ops@example.test>' }, () => {
      expect(fromIdentity(undefined)).toEqual({ name: 'Ops Team', address: 'ops@example.test' });
    });
  });
});

test.describe('List-Id follows the recipient world', () => {
  test("the namespace is the recipient world's host, never a tenant's own host", () => {
    // MARKETING_HOSTS is unset here, so the marketing world is its default host.
    const marketing = unsubscribeHeaders('user_1', 'digests', 'https://marketing.bcsit-gmbh.de');
    expect(marketing['List-Id']).toBe('<digests.marketing.bcsit-gmbh.de>');
    expect(marketing['List-Unsubscribe']).toContain('https://marketing.bcsit-gmbh.de/');

    // Any other host reads as the default world: its configured host.
    const configured = new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').host;
    const tenant = unsubscribeHeaders('user_1', 'digests', 'https://crm.some-tenant.example');
    expect(tenant['List-Id']).toBe(`<digests.${configured}>`);
    // …while the opt-out link itself still opens the host it was given.
    expect(tenant['List-Unsubscribe']).toContain('https://crm.some-tenant.example/');
  });
});

test.describe('mail accent a tenant left unset', () => {
  test('SaleVali magenta for MARKETING, the product blue otherwise — never preview green', () => {
    expect(mailAccentFor('MARKETING')).toBe(ACCENT_SWATCH.magenta);
    expect(mailAccentFor('INTERNSHIP')).toBe('#2563eb');
    expect(mailAccentFor(null)).toBe('#2563eb');
  });
});
