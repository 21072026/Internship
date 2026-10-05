// ---------------------------------------------------------------------------
// The mentee's own completion certificate in the portal, and LinkedIn's
// "add to profile" link for it. Dependency-free (zero imports) so the unit test
// runs under plain `node --test` and a page can import it without dragging
// Prisma into a bundle.
//
// Who may get the certificate PDF, and why (#813, unchanged here):
//  - GENERATING it (POST /api/mentorship/[id]/certificate) is the relation's
//    mentor or an admin of the tenant — never the mentee: a certificate the
//    holder writes themselves certifies nothing.
//  - The PDF is stored as a `Document` of type CERTIFICATE OWNED BY THE MENTEE,
//    so DOWNLOADING it is GET /api/documents/[id] under `canAccessUserDocs`:
//    the owner, an admin of the owner's org, or a mentor with an
//    access-granting relation to the owner. Any other mentee gets 403 (a
//    foreign tenant 404). The mentee therefore already can download exactly
//    their own certificate; this feature only makes it findable, and does not
//    widen any route.
//
// Deliberately NOT here: a public verification page, and LinkedIn's
// `certUrl` / `certId` parameters. A link anyone can open that proves a named
// person finished a named programme is a separate consent question (it
// publishes personal data off the platform), not a side effect of a button.
// ---------------------------------------------------------------------------

/** The subset of a Document row this module reads. */
export interface CertificateDocLike {
  id: string;
  ownerId: string | null;
  uploaderId: string;
  type: string;
  title: string;
  isTemplate: boolean;
  createdAt: Date;
}

export interface IssuedCertificate {
  documentId: string;
  /** The certificate title exactly as the PDF prints it. */
  name: string;
  issuedAt: Date;
}

/**
 * The newest certificate ISSUED to `ownerId`, or null.
 *
 * "Issued" means what the certificate route writes: a CERTIFICATE document
 * owned by the person, uploaded by somebody else (the mentor/admin who
 * generated it), titled `<certificate title> — <name>`. That excludes:
 *  - a file the person uploaded themselves with type CERTIFICATE (anyone can
 *    upload a "certificate" — it would be a self-issued claim on LinkedIn);
 *  - the reference-letter variant, which the route stores with the same
 *    document type but its own title (a letter is not a certification);
 *  - templates and other people's documents.
 *
 * `certificateTitles` are the certificate-variant titles in every locale
 * (`certificateTitle('CERTIFICATE', locale)`), passed in to keep this pure.
 *
 * `issuedOnOrAfter` binds the certificate to ONE relation. The generate route
 * stores no relation id on the Document (a certificate belongs to the person),
 * so the only data that separates "issued for this pairing" from "issued for
 * an earlier, completed one" is time: a certificate generated before the
 * relation started cannot be this relation's. Pass the relation's `startDate`;
 * an older certificate then leaves the card in its pending state instead of
 * presenting a previous programme's PDF and date as this one's.
 */
export function pickIssuedCertificate(
  docs: CertificateDocLike[],
  ownerId: string,
  certificateTitles: string[],
  issuedOnOrAfter?: Date | null,
): IssuedCertificate | null {
  const floor = issuedOnOrAfter ? issuedOnOrAfter.getTime() : null;
  let best: IssuedCertificate | null = null;
  for (const d of docs) {
    if (d.type !== 'CERTIFICATE' || d.isTemplate) continue;
    if (d.ownerId !== ownerId || d.uploaderId === ownerId) continue;
    if (floor !== null && d.createdAt.getTime() < floor) continue;
    const name = certificateTitles.find((t) => t && d.title.startsWith(issuedCertificateTitlePrefix(t)));
    if (!name) continue;
    if (!best || d.createdAt.getTime() > best.issuedAt.getTime()) {
      best = { documentId: d.id, name, issuedAt: d.createdAt };
    }
  }
  return best;
}

/** The title prefix the generate route writes: `<certificate title> — <name>`. */
export function issuedCertificateTitlePrefix(certificateTitle: string): string {
  return `${certificateTitle} — `;
}

export const LINKEDIN_ADD_TO_PROFILE = 'https://www.linkedin.com/profile/add';

/**
 * LinkedIn's official add-to-profile URL for a certification. The issue date is
 * the day the PDF was generated, in UTC (LinkedIn takes year + month only).
 * Every value is URL-encoded by URLSearchParams.
 */
export function linkedInAddToProfileUrl(input: {
  name: string;
  organizationName: string;
  issuedAt: Date;
}): string {
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: input.name,
    organizationName: input.organizationName,
    issueYear: String(input.issuedAt.getUTCFullYear()),
    issueMonth: String(input.issuedAt.getUTCMonth() + 1),
  });
  // No certUrl / certId on purpose — see the header comment.
  return `${LINKEDIN_ADD_TO_PROFILE}?${params.toString()}`;
}
