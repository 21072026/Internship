import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import { isSsoConfigComplete, isSsoProviderImplemented } from '@/lib/sso';
import { samlForOrg } from '@/lib/ssoSaml';
import { certificateInfo } from '@/lib/ssoMetadata';
import { certificateStatus } from '@/lib/ssoCertificateRule';
import { SsoFetchError, probePublicUrl } from '@/lib/ssoFetch';
import { requirePermission } from '@/lib/authz';

// POST /api/admin/organizations/[id]/sso/test — "Test connection" (#1933).
// Runs the READ-ONLY half of a SAML sign-in against the org's STORED config and
// reports each step: is the config complete, does the certificate parse and is
// it in date, can we build the AuthnRequest, and does the IdP's entry point
// answer. It never reaches the ACS, never provisions a user and never mints a
// session or a grant — the only write is the audit line saying it ran.
//
// WHO: the org's own ADMIN or a super admin of its world, like the role
// mappings beside it. Testing is not setting: a tenant admin may check the
// trust the operator configured. The refusal comes before the lookup.
//
// The entry-point probe is an outbound request on stored, admin-supplied data,
// so it goes through the SSRF guard (src/lib/ssoFetch.ts). Any HTTP answer
// below 500 counts as reachable — an IdP that answers our AuthnRequest with
// its login page (200) or a redirect to it is up; we are not signing anyone in.

type Check = { check: string; ok: boolean; detail?: string };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('org.settings.write', { request: _req });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  if (!(await isSuperAdminFor(session, id))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, 'POST /api/admin/organizations/[id]/sso/test', id);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  const org = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, slug: true, ssoProvider: true, ssoIssuer: true, ssoEntryPoint: true, ssoCertificate: true },
  });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  const checks: Check[] = [];
  const complete = isSsoConfigComplete({ ...org, ssoEnabled: true });
  checks.push({ check: 'config_complete', ok: complete });
  const supported = isSsoProviderImplemented(org.ssoProvider);
  checks.push({ check: 'provider_supported', ok: supported, ...(supported ? {} : { detail: String(org.ssoProvider ?? '') }) });

  if (complete && supported) {
    const info = certificateInfo(org.ssoCertificate);
    if (!info) {
      checks.push({ check: 'certificate', ok: false, detail: 'unparseable' });
    } else {
      const { status, daysLeft } = certificateStatus(info.notAfter, new Date());
      checks.push({ check: 'certificate', ok: status !== 'expired', detail: `${status}:${daysLeft}` });
    }

    let authorizeUrl: string | null = null;
    try {
      authorizeUrl = await samlForOrg(org.slug, org).getAuthorizeUrlAsync('', undefined, {});
      checks.push({ check: 'authn_request', ok: true });
    } catch (e) {
      checks.push({ check: 'authn_request', ok: false, detail: e instanceof Error ? e.message.slice(0, 200) : 'failed' });
    }

    if (authorizeUrl) {
      try {
        const status = await probePublicUrl(authorizeUrl);
        checks.push({ check: 'entry_point', ok: status < 500, detail: `HTTP ${status}` });
      } catch (e) {
        if (!(e instanceof SsoFetchError)) throw e;
        checks.push({ check: 'entry_point', ok: false, detail: `${e.code}: ${e.message}` });
      }
    }
  }

  const ok = checks.every((c) => c.ok);
  await logActivity({
    action: 'sso.test_connection',
    level: ok ? 'info' : 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email,
    targetType: 'Organization',
    targetId: id,
    orgId: id,
    detail: ok ? 'passed' : `failed: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`,
  });
  return NextResponse.json({ ok, checks });
}
