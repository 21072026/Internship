// Unit tests for where an organization's brand name may become the product
// name (#2936) — pure node, no browser/page, no database.
//
// Three rules are pinned here:
//   1. the default vertical (INTERNSHIP) always prints its default product
//      name, even for an organization whose older white-label `brandName` is
//      set — titles, mail, calendar files, the authenticator issuer and room
//      names in that world were never tenant data;
//   2. a brand name in an authenticator issuer is cleaned to what the Key URI
//      format accepts;
//   3. a brand name in a meeting-room prefix is capped and falls back to the
//      vertical default when nothing usable is left (the link column is 191
//      characters).
import { test, expect } from '@playwright/test';
import { brandProductName, defaultBrand, productNameIn, type ResolvedBrand } from '@/lib/orgBrand';
import { productNameFor } from '@/lib/verticals';
import { otpauthIssuer, otpauthUrl } from '@/lib/totp';
import { generateMeetingRoomName } from '@/lib/meetingRoom';

function branded(vertical: 'INTERNSHIP' | 'MARKETING', productName: string): ResolvedBrand {
  return { ...defaultBrand(vertical), source: 'org', orgId: 'org_1', productName };
}

test.describe('brandProductName / productNameIn', () => {
  test('a branded INTERNSHIP organization still prints the default product name', () => {
    const brand = branded('INTERNSHIP', 'Acme Talent');
    expect(brandProductName(brand)).toBe(productNameFor('INTERNSHIP'));
    expect(productNameIn(brand, 'INTERNSHIP')).toBe(productNameFor('INTERNSHIP'));
  });

  test('a branded MARKETING organization prints its brand name', () => {
    const brand = branded('MARKETING', 'Northwind');
    expect(brandProductName(brand)).toBe('Northwind');
    expect(productNameIn(brand, 'MARKETING')).toBe('Northwind');
  });

  test('a brand is never printed in the other vertical', () => {
    expect(productNameIn(branded('MARKETING', 'Northwind'), 'INTERNSHIP')).toBe(productNameFor('INTERNSHIP'));
    expect(productNameIn(branded('INTERNSHIP', 'Acme Talent'), 'MARKETING')).toBe(productNameFor('MARKETING'));
  });

  test('a default brand prints the vertical default', () => {
    for (const v of ['INTERNSHIP', 'MARKETING'] as const) {
      expect(brandProductName(defaultBrand(v))).toBe(productNameFor(v));
    }
  });
});

test.describe('otpauthIssuer', () => {
  test('a plain name is unchanged', () => {
    expect(otpauthIssuer(productNameFor('INTERNSHIP'))).toBe(productNameFor('INTERNSHIP'));
  });

  test('a colon is removed, so the label and the issuer parameter agree', () => {
    expect(otpauthIssuer('Acme: Sales')).toBe('Acme Sales');
    const uri = otpauthUrl('JBSWY3DPEHPK3PXP', 'alice@example.com', 'Acme: Sales');
    const [path, query] = uri.split('?');
    expect(decodeURIComponent(path)).toBe('otpauth://totp/Acme Sales:alice@example.com');
    expect(new URLSearchParams(query).get('issuer')).toBe('Acme Sales');
  });

  test('nothing usable left falls back', () => {
    expect(otpauthIssuer(' : ', 'Fallback')).toBe('Fallback');
  });
});

test.describe('generateMeetingRoomName prefix', () => {
  test('default names give the same prefix as before', () => {
    expect(generateMeetingRoomName('INTERNSHIP')).toMatch(/^InternshipCRM-[0-9a-f]{16}$/);
    const marketingPrefix = productNameFor('MARKETING').replace(/[^A-Za-z0-9]/g, '');
    expect(generateMeetingRoomName('MARKETING', productNameFor('MARKETING'))).toMatch(
      new RegExp(`^${marketingPrefix}-[0-9a-f]{16}$`),
    );
  });

  test('a long brand name is capped at 32 characters', () => {
    const room = generateMeetingRoomName('MARKETING', 'A'.repeat(150));
    expect(room).toMatch(/^A{32}-[0-9a-f]{16}$/);
  });

  test('a name with no ASCII letter or digit falls back to the vertical default', () => {
    const marketingPrefix = productNameFor('MARKETING').replace(/[^A-Za-z0-9]/g, '');
    expect(generateMeetingRoomName('MARKETING', 'ÇÖŞ ĞÜ')).toMatch(new RegExp(`^${marketingPrefix}-[0-9a-f]{16}$`));
  });
});
