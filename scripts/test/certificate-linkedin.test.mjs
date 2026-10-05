// Unit tests for the portal certificate card rule + LinkedIn add-to-profile URL
// (src/lib/certificateLinkedIn.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickIssuedCertificate,
  linkedInAddToProfileUrl,
  LINKEDIN_ADD_TO_PROFILE,
  issuedCertificateTitlePrefix,
} from '../../src/lib/certificateLinkedIn.ts';

const TITLES = ['Internship Completion Certificate', 'Staj Tamamlama Belgesi', 'Praktikumsbescheinigung'];
const ME = 'mentee-1';

function doc(over = {}) {
  return {
    id: 'd1',
    ownerId: ME,
    uploaderId: 'mentor-1',
    type: 'CERTIFICATE',
    title: 'Internship Completion Certificate — Ada Lovelace',
    isTemplate: false,
    createdAt: new Date('2026-09-15T10:00:00Z'),
    ...over,
  };
}

test('an issued certificate is picked with the printed title and its issue date', () => {
  const got = pickIssuedCertificate([doc()], ME, TITLES);
  assert.deepEqual(got, {
    documentId: 'd1',
    name: 'Internship Completion Certificate',
    issuedAt: new Date('2026-09-15T10:00:00Z'),
  });
});

test('the newest issued certificate wins, in any locale', () => {
  const got = pickIssuedCertificate(
    [
      doc({ id: 'old' }),
      doc({ id: 'new', title: 'Praktikumsbescheinigung — Ada', createdAt: new Date('2026-10-01T00:00:00Z') }),
    ],
    ME,
    TITLES,
  );
  assert.equal(got?.documentId, 'new');
  assert.equal(got?.name, 'Praktikumsbescheinigung');
});

test('a self-uploaded "certificate" is never treated as issued', () => {
  assert.equal(pickIssuedCertificate([doc({ uploaderId: ME })], ME, TITLES), null);
});

test('a reference letter (same document type, other title) is not a certificate', () => {
  assert.equal(pickIssuedCertificate([doc({ title: 'Reference Letter — Ada' })], ME, TITLES), null);
});

test("someone else's certificate, a template or another type is ignored", () => {
  assert.equal(pickIssuedCertificate([doc({ ownerId: 'mentee-2' })], ME, TITLES), null);
  assert.equal(pickIssuedCertificate([doc({ isTemplate: true })], ME, TITLES), null);
  assert.equal(pickIssuedCertificate([doc({ type: 'CV' })], ME, TITLES), null);
  assert.equal(pickIssuedCertificate([], ME, TITLES), null);
});

test('a title that only starts with the certificate words (no separator) does not match', () => {
  assert.equal(pickIssuedCertificate([doc({ title: 'Internship Completion Certificate draft' })], ME, TITLES), null);
});

test("a certificate issued before this relation started is an earlier programme's, not this one's", () => {
  const start = new Date('2026-09-20T00:00:00Z');
  // Issued for relation A (before B started) -> B shows pending.
  assert.equal(pickIssuedCertificate([doc()], ME, TITLES, start), null);
  // Issued on/after B started -> it is B's.
  const own = doc({ id: 'b', createdAt: new Date('2026-09-20T00:00:00Z') });
  assert.equal(pickIssuedCertificate([doc(), own], ME, TITLES, start)?.documentId, 'b');
  // No floor given (legacy caller) keeps the newest-wins behaviour.
  assert.equal(pickIssuedCertificate([doc()], ME, TITLES, null)?.documentId, 'd1');
});

test('the title prefix is the generate route format', () => {
  assert.equal(issuedCertificateTitlePrefix('Praktikumsbescheinigung'), 'Praktikumsbescheinigung — ');
});

test('LinkedIn URL: official endpoint, CERTIFICATION_NAME task, encoded values, UTC year/month', () => {
  const url = linkedInAddToProfileUrl({
    name: 'Staj Tamamlama Belgesi',
    organizationName: 'Acme & Söhne GmbH',
    issuedAt: new Date('2026-12-31T23:30:00Z'),
  });
  assert.ok(url.startsWith(`${LINKEDIN_ADD_TO_PROFILE}?`));
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/profile/add');
  assert.equal(u.searchParams.get('startTask'), 'CERTIFICATION_NAME');
  assert.equal(u.searchParams.get('name'), 'Staj Tamamlama Belgesi');
  assert.equal(u.searchParams.get('organizationName'), 'Acme & Söhne GmbH');
  assert.equal(u.searchParams.get('issueYear'), '2026');
  assert.equal(u.searchParams.get('issueMonth'), '12');
  // The raw string carries no unencoded ampersand inside a value.
  assert.ok(url.includes('Acme+%26+S%C3%B6hne+GmbH'));
});

test('LinkedIn URL never carries a public certificate URL or id', () => {
  const u = new URL(linkedInAddToProfileUrl({ name: 'X', organizationName: 'Y', issuedAt: new Date() }));
  assert.equal(u.searchParams.has('certUrl'), false);
  assert.equal(u.searchParams.has('certId'), false);
});
