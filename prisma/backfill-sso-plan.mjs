// Grandfather tenants that configured SSO before it was a paid feature (#1742).
//
// WHY THIS EXISTS. Until #1742, SAML SSO could be configured on ANY plan — the
// entitlement keys had zero call sites. `Organization.plan` defaults to FREE,
// so a tenant that legitimately set up its IdP is very likely sitting on FREE
// or PRO. The moment the gate deploys, `isSsoActive()` also requires SSO_SAML,
// the login and ACS routes bounce every one of that tenant's users to
// `?error=sso_unavailable`, and those users cannot fall back to a password:
// JIT-provisioned SSO accounts are stored with `password: '!sso-no-login'`
// (src/lib/ssoProvisioning.ts). That is a hard lockout, not a downgrade.
//
// So: any org whose SSO was ON and COMPLETE before the gate keeps working, by
// being moved to the plan that now sells it. What was legal when it was written
// stays legal; the gate applies to everything written from here on.
//
// Idempotent and safe to re-run: it only ever touches rows that are (a) SSO-
// enabled, (b) completely configured with an implemented provider, and (c) not
// already on ENTERPRISE. On a fresh install it finds nothing and prints zeros.
//
// Branding is deliberately NOT grandfathered. An unentitled tenant losing the
// ability to EDIT its brand fields is the intended gate, not an outage — and
// clearing them is exempt from the gate anyway, so nothing is stuck. Rows in
// that position are reported below so the operator sees them, never changed.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Mirrors isSsoConfigComplete() + isSsoProviderImplemented() in src/lib/sso.ts.
// Duplicated rather than imported: this script runs as plain node on the
// deploy host against the built image's schema, with no TS toolchain.
const filled = (s) => typeof s === 'string' && s.trim().length > 0;
function ssoWasLive(o) {
  if (!o.ssoEnabled) return false;
  if (o.ssoProvider !== 'saml') return false; // 'oidc' never completed a login
  return filled(o.ssoIssuer) && filled(o.ssoEntryPoint) && filled(o.ssoCertificate);
}

async function main() {
  const orgs = await prisma.organization.findMany({
    select: {
      id: true, slug: true, plan: true, ssoEnabled: true, ssoProvider: true,
      ssoIssuer: true, ssoEntryPoint: true, ssoCertificate: true,
      brandName: true, brandLogoUrl: true, brandColor: true, supportEmail: true,
    },
  });

  let upgraded = 0;
  let skipped = 0;
  for (const o of orgs) {
    if (o.plan === 'ENTERPRISE' || !ssoWasLive(o)) { skipped++; continue; }
    await prisma.organization.update({ where: { id: o.id }, data: { plan: 'ENTERPRISE' } });
    upgraded++;
    console.log(`backfill-sso-plan: ${o.slug} ${o.plan} -> ENTERPRISE (SSO was live before the gate)`);
  }

  // Reported, not changed — see the header.
  const brandedButUnentitled = orgs.filter(
    (o) => o.plan !== 'ENTERPRISE'
      && (filled(o.brandName) || filled(o.brandLogoUrl) || filled(o.brandColor) || filled(o.supportEmail)),
  );
  for (const o of brandedButUnentitled) {
    console.log(`backfill-sso-plan: NOTE ${o.slug} is on ${o.plan} with white-label fields set — still rendered, no longer editable (clearing is allowed)`);
  }

  console.log(`backfill-sso-plan: upgraded=${upgraded} skipped=${skipped} branded-unentitled=${brandedButUnentitled.length}`);
}

main()
  .catch((error) => {
    console.error('backfill-sso-plan failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
