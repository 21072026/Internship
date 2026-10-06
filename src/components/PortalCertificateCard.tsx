import { Award, Download, ExternalLink, Linkedin } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { canIssueCertificate, type EligibilityRelation } from '@/lib/certificateEligibility';
import { certificateTitle, type CertLocale } from '@/lib/certificateTemplates';
import {
  pickIssuedCertificate,
  linkedInAddToProfileUrl,
  issuedCertificateTitlePrefix,
} from '@/lib/certificateLinkedIn';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getOrgBranding } from '@/lib/orgBranding';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { formatDate } from '@/lib/relativeTime';

const CERT_LOCALES: CertLocale[] = ['en', 'tr', 'de'];

// "Your certificate" in the mentee's own portal. Everything the card shows is
// read, never claimed:
//  - it renders only when the relation is certificate-eligible by the SAME rule
//    the generate route and the admin/mentor pages use (canIssueCertificate);
//  - the download and the LinkedIn button appear only once a certificate has
//    actually been issued (a generated PDF owned by this user), and the date,
//    title and issuer come from that document and the tenant branding the PDF
//    prints — see src/lib/certificateLinkedIn.ts for who may download it.
// The download reuses GET /api/documents/[id], which already answers the
// owner and nobody else outside staff; no route was widened for this.
export async function PortalCertificateCard({
  userId,
  orgId,
  relation,
}: {
  userId: string;
  orgId: string | null | undefined;
  relation: EligibilityRelation & { startDate: Date };
}) {
  // Internship-only surface (the certificate is an internship completion
  // certificate). The portal layout already redirects a non-mentorship
  // tenant; this keeps the card correct if it is ever mounted elsewhere.
  if (!(await shellCapabilities(orgId)).includes('mentorship')) return null;

  const { t, locale } = await getServerDictionary();
  const stages = await resolvePipelineStages(orgId, locale);
  if (!canIssueCertificate(relation, stages)) return null;

  const c = t.portal.certificateCard;
  const titles = CERT_LOCALES.map((l) => certificateTitle('CERTIFICATE', l));
  // Own documents only: `ownerId` is the signed-in user, so this cannot reach
  // anybody else's certificate (and Document carries no orgId — its owner's
  // org is the caller's by construction).
  //
  // Every "issued" condition is in the WHERE, not only in the pure filter, so
  // the cap cannot be crowded out: twenty self-uploaded CERTIFICATE files (or
  // reference letters) would otherwise push the real certificate out of the
  // window and flip the card back to pending.
  //
  // Certificates belong to the person, not to a relation (the generate route
  // stores no relation id), so `createdAt >= startDate` is what binds one to
  // THIS pairing — a certificate issued for an earlier, completed programme is
  // not presented as this one's (see pickIssuedCertificate).
  const docs = await prisma.document.findMany({
    where: {
      ownerId: userId,
      uploaderId: { not: userId },
      type: 'CERTIFICATE',
      isTemplate: false,
      createdAt: { gte: relation.startDate },
      OR: titles.map((title) => ({ title: { startsWith: issuedCertificateTitlePrefix(title) } })),
    },
    select: { id: true, ownerId: true, uploaderId: true, type: true, title: true, isTemplate: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const issued = pickIssuedCertificate(docs, userId, titles, relation.startDate);
  // The issuer the PDF prints: certificatePdf.ts draws `branding.name`, and the
  // generate route resolves that branding from the RELATION's tenant — the
  // same org passed in here (the mentee's own). Known, accepted drift: this is
  // the branding name NOW. If the tenant renames its brand after issue, the
  // card and LinkedIn show the new name while the stored PDF keeps the old
  // one. Storing the printed issuer would need a Document column (a schema
  // change of its own); the activity-log entry is no substitute, because
  // retention purges it.
  const issuer = issued ? (await getOrgBranding(orgId)).name : null;

  return (
    <Card data-testid="portal-certificate-card" className="mb-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <CardTitle>{c.title}</CardTitle>
        </div>
      </CardHeader>

      {!issued || !issuer ? (
        <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="portal-certificate-pending">
          {c.notIssued}
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="font-semibold text-gray-900 dark:text-gray-100" data-testid="portal-certificate-name">
              {issued.name}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-sm text-gray-600 dark:text-gray-300">
              <dt>{c.issuedBy}</dt>
              <dd className="break-words" data-testid="portal-certificate-issuer">{issuer}</dd>
              <dt>{c.issuedOn}</dt>
              <dd>{formatDate(issued.issuedAt, locale)}</dd>
            </dl>
          </div>

          <div className="flex flex-col sm:flex-row flex-wrap gap-2">
            <a
              href={`/api/documents/${issued.documentId}`}
              download
              data-testid="portal-certificate-download"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {c.download}
            </a>
            {/* An external site, not an image: a new tab is right here (#2147
                is about user-supplied images). No certUrl/certId — a public
                certificate URL is a separate consent question. */}
            <a
              href={linkedInAddToProfileUrl({ name: issued.name, organizationName: issuer, issuedAt: issued.issuedAt })}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="portal-certificate-linkedin"
              aria-describedby="portal-certificate-linkedin-hint"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <Linkedin className="h-4 w-4 text-[#0A66C2] dark:text-sky-400" aria-hidden="true" />
              {c.addToLinkedIn}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">{c.newTab}</span>
            </a>
          </div>
          <p id="portal-certificate-linkedin-hint" className="text-xs text-gray-500 dark:text-gray-400">
            {c.linkedInHint}
          </p>
        </div>
      )}
    </Card>
  );
}
