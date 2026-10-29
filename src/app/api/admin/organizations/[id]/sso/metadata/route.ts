import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import {
  MAX_METADATA_BYTES,
  MetadataError,
  certificateInfo,
  parseIdpMetadata,
  preferredCertificate,
  toPem,
} from '@/lib/ssoMetadata';
import { certificateStatus } from '@/lib/ssoCertificateRule';
import { SsoFetchError, fetchPublicText } from '@/lib/ssoFetch';
import { requirePermission } from '@/lib/authz';

// POST /api/admin/organizations/[id]/sso/metadata — read an IdP's SAML metadata
// (pasted/uploaded XML, or a URL we fetch) and answer with a PREVIEW of the
// issuer, entry point and signing certificate it carries (#1933).
//
// IT WRITES NOTHING. The admin confirms the preview, the card fills its fields,
// and the save goes through `PATCH /api/admin/organizations` like a hand-typed
// one — validateSsoConfig (which now parses the certificate) and the #1575
// super-admin gate included. Never write config straight from a fetch.
//
// WHO. The same people who may set the identity provider: a super admin of the
// org's world (docs/sso-saml.md § Who may set the identity provider). The
// org's own ADMIN is refused with the same `sso_super_admin_only` code the
// PATCH answers — a preview they could never apply is no use to them, and the
// URL form makes this server fetch an address on the caller's say-so, which is
// not a door to open wider than the people who can act on the answer.
//
// The URL form goes through src/lib/ssoFetch.ts: the SSRF guard on every hop
// (redirects included), a 5s timeout and the same byte cap as pasted XML.

const bodySchema = z.union([
  z.object({ xml: z.string().min(1).max(MAX_METADATA_BYTES) }).strict(),
  z.object({ url: z.string().trim().min(1).max(2000) }).strict(),
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  // Ownership before the row is touched, so a foreign id is never confirmed.
  if (!(await isSuperAdminFor(session, id))) {
    const own = resolveOrgId(session) === id;
    await logCrossTenantDenial(session, 'POST /api/admin/organizations/[id]/sso/metadata', id);
    return own
      ? NextResponse.json(
          { code: 'sso_super_admin_only', error: 'Only a super admin may set an organization\'s identity provider' },
          { status: 403 },
        )
      : NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: 'invalid_body', error: 'Send either { xml } or { url }' }, { status: 400 });
  }

  let xml: string;
  if ('url' in parsed.data) {
    try {
      xml = await fetchPublicText(parsed.data.url, MAX_METADATA_BYTES);
    } catch (e) {
      if (e instanceof SsoFetchError) return NextResponse.json({ code: e.code, error: e.message }, { status: 400 });
      throw e;
    }
  } else {
    xml = parsed.data.xml;
  }

  let metadata;
  try {
    metadata = parseIdpMetadata(xml);
  } catch (e) {
    if (e instanceof MetadataError) return NextResponse.json({ code: e.code, error: e.message }, { status: 400 });
    throw e;
  }

  const now = new Date();
  const chosen = preferredCertificate(metadata.certificates, now);
  const certificates = metadata.certificates.map((c) => {
    const info = certificateInfo(c);
    return {
      chosen: c === chosen,
      parsed: !!info,
      fingerprintSha256: info?.fingerprintSha256 ?? null,
      subject: info?.subject ?? null,
      notBefore: info?.notBefore.toISOString() ?? null,
      notAfter: info?.notAfter.toISOString() ?? null,
      ...(info ? certificateStatus(info.notAfter, now) : { status: null, daysLeft: null }),
    };
  });

  return NextResponse.json({
    preview: {
      ssoProvider: 'saml',
      ssoIssuer: metadata.issuer,
      ssoEntryPoint: metadata.entryPoint,
      // The public certificate the admin just handed us, as the PEM the card's
      // field takes. It is their own input coming back, not the stored value
      // (which the list view never returns).
      ssoCertificate: chosen ? toPem(chosen) : null,
      sloUrl: metadata.sloUrl ?? null,
      certificates,
    },
  });
}
