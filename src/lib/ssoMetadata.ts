// IdP metadata in (#1933) — the mirror image of the SP metadata we publish
// (#1931, `spMetadataXml` in src/lib/ssoSaml.ts). An admin hands us the IdP's
// SAML 2.0 metadata document (pasted, uploaded or by URL) and we read the three
// values the SSO card needs out of it — issuer, entry point, signing
// certificate — instead of asking for them to be copied by hand, which is where
// SSO onboarding actually fails (a wrong cert, trailing whitespace, a truncated
// PEM).
//
// PARSE ONLY. Nothing here writes: the route that calls this answers with a
// preview, and the values reach the database only through the one validated
// write path, `PATCH /api/admin/organizations` (validateSsoConfig + the #1575
// super-admin gate). Never write config straight from a fetch.
//
// XXE. Metadata is customer-supplied XML, which is the classic place for an
// external-entity read or a billion-laughs expansion. Defence in depth:
//   1. the input is capped (`MAX_METADATA_BYTES`) before any parsing;
//   2. a document carrying a DOCTYPE or an ENTITY declaration is refused
//      outright — SAML metadata never needs one, so refusing costs nothing and
//      closes the whole class before a parser sees it;
//   3. the parser (@xmldom/xmldom) resolves no external entity in any case.
//
// Server-only (node crypto). Dependency-free beyond the parser and node, so the
// unit runner loads it (scripts/test/sso-metadata.test.mjs).

import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';

/** Largest metadata document we read. Federation aggregates are refused, not truncated. */
export const MAX_METADATA_BYTES = 256 * 1024;

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

/** Why a document was refused — a code the route returns and the UI translates. */
export type MetadataErrorCode =
  | 'too_large'
  | 'dtd_not_allowed'
  | 'not_xml'
  | 'no_idp_descriptor'
  | 'no_sso_service'
  | 'no_certificate';

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  constructor(code: MetadataErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ParsedIdpMetadata {
  /** `EntityDescriptor@entityID` — what the SSO card calls the issuer. */
  issuer: string;
  /** The SingleSignOnService location, HTTP-Redirect preferred (what node-saml sends). */
  entryPoint: string;
  /** Every signing certificate, as bare base64 (no armour, no whitespace). */
  certificates: string[];
  /** The SingleLogoutService location, when the IdP advertises one (#1952). */
  sloUrl?: string;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function elements(parent: { getElementsByTagNameNS(ns: string, name: string): ArrayLike<unknown> }, ns: string, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(ns, name) as ArrayLike<Element>);
}

function pickService(services: Element[]): string | undefined {
  const located = services.filter((s) => (s.getAttribute('Location') ?? '').trim());
  const of = (binding: string) => located.find((s) => s.getAttribute('Binding') === binding);
  const chosen = of(BINDING_REDIRECT) ?? of(BINDING_POST) ?? located[0];
  return chosen?.getAttribute('Location')?.trim() || undefined;
}

/** Throws `MetadataError`; never returns a half-read document. */
export function parseIdpMetadata(xml: string): ParsedIdpMetadata {
  if (byteLength(xml) > MAX_METADATA_BYTES) {
    throw new MetadataError('too_large', `Metadata is larger than ${MAX_METADATA_BYTES / 1024} KiB`);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new MetadataError('dtd_not_allowed', 'Metadata with a DOCTYPE or entity declaration is not accepted');
  }

  const fail = (msg: string) => {
    throw new MetadataError('not_xml', `Not a well-formed XML document: ${String(msg).split('\n')[0]}`);
  };
  let doc: Document;
  try {
    doc = new DOMParser({
      locator: {},
      errorHandler: { warning: () => {}, error: fail, fatalError: fail },
    }).parseFromString(xml.trim(), 'text/xml') as unknown as Document;
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    throw new MetadataError('not_xml', 'Not a well-formed XML document');
  }
  if (!doc?.documentElement) throw new MetadataError('not_xml', 'Not a well-formed XML document');

  // The first EntityDescriptor that is an IdP — a root EntityDescriptor, or one
  // inside an EntitiesDescriptor (a small federation export).
  const entity = elements(doc, MD_NS, 'EntityDescriptor').find(
    (e) => elements(e, MD_NS, 'IDPSSODescriptor').length > 0,
  );
  const idp = entity ? elements(entity, MD_NS, 'IDPSSODescriptor')[0] : undefined;
  const issuer = entity?.getAttribute('entityID')?.trim();
  if (!entity || !idp || !issuer) {
    throw new MetadataError('no_idp_descriptor', 'No identity-provider descriptor (IDPSSODescriptor with an entityID) found');
  }

  const entryPoint = pickService(elements(idp, MD_NS, 'SingleSignOnService'));
  if (!entryPoint) throw new MetadataError('no_sso_service', 'The metadata advertises no SingleSignOnService');

  // Signing keys only: a KeyDescriptor with use="encryption" is not what
  // signs the assertion. One without `use` serves both, per the spec.
  const certificates: string[] = [];
  for (const kd of elements(idp, MD_NS, 'KeyDescriptor')) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const c of elements(kd, DS_NS, 'X509Certificate')) {
      const body = (c.textContent ?? '').replace(/\s+/g, '');
      if (body && !certificates.includes(body)) certificates.push(body);
    }
  }
  if (!certificates.length) throw new MetadataError('no_certificate', 'The metadata carries no signing certificate');

  const sloUrl = pickService(elements(idp, MD_NS, 'SingleLogoutService'));
  return { issuer, entryPoint, certificates, ...(sloUrl ? { sloUrl } : {}) };
}

/** A certificate body (bare base64 or PEM) as PEM — what the SSO card stores. */
export function toPem(cert: string): string {
  const trimmed = cert.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

export interface CertificateInfo {
  notBefore: Date;
  notAfter: Date;
  /** Colon-separated upper-case hex, as `openssl x509 -fingerprint -sha256` prints it. */
  fingerprintSha256: string;
  subject: string;
}

/** Null when the value is not one parseable X.509 certificate. */
export function certificateInfo(cert: string | null | undefined): CertificateInfo | null {
  if (!cert || !cert.trim()) return null;
  try {
    const x = new X509Certificate(toPem(cert));
    return {
      notBefore: new Date(x.validFrom),
      notAfter: new Date(x.validTo),
      fingerprintSha256: x.fingerprint256,
      subject: x.subject.replace(/\n/g, ', '),
    };
  } catch {
    return null;
  }
}

/**
 * Of several signing certificates (an IdP mid-rotation advertises two), the
 * one to store: already valid, latest expiry. Falls back to the latest expiry
 * when none is valid yet, and to the first when none parses.
 */
export function preferredCertificate(certs: string[], now: Date = new Date()): string | undefined {
  const parsed = certs
    .map((c) => ({ c, info: certificateInfo(c) }))
    .filter((p): p is { c: string; info: CertificateInfo } => p.info !== null);
  const current = parsed.filter((p) => p.info.notBefore <= now && p.info.notAfter > now);
  const pool = current.length ? current : parsed;
  pool.sort((a, b) => b.info.notAfter.getTime() - a.info.notAfter.getTime());
  return pool[0]?.c ?? certs[0];
}
