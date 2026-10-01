import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTACT_BASES,
  CONTACT_CHANNELS,
  MACHINE_WRITERS,
  DOI_CONFIRM_WINDOW_DAYS,
  capDay,
  marketingEmailAllowed,
  refuseConfirmation,
  refuseWrite,
  writeReplaces,
} from '../../src/lib/contactPermissionRule.ts';

// The contact-permission rule (#2577): who may write which basis, when a write
// replaces what is stored, and the one gate every marketing send asks. Pure —
// no database. docs/contact-permission.md.

const NOW = new Date('2026-09-29T12:00:00Z');
const REASON = 'Invoice 2026-0042, paid subscription since March';

test('machine paths (import, ingest, the SaleVali newsletter flag) cannot write any basis but NONE', () => {
  for (const writer of MACHINE_WRITERS) {
    for (const channel of CONTACT_CHANNELS) {
      for (const basis of CONTACT_BASES) {
        // Even with every piece of "evidence" a caller could hand in.
        const refusal = refuseWrite({ writer, channel, basis, confirmedAt: NOW, reason: REASON });
        if (basis === 'NONE') assert.equal(refusal, null, `${writer} ${channel} NONE`);
        else assert.equal(refusal, 'basis_not_allowed_for_writer', `${writer} ${channel} ${basis}`);
      }
    }
  }
});

test('a machine write never replaces a stored row — not a confirmation, not a revocation', () => {
  for (const writer of MACHINE_WRITERS) {
    assert.equal(writeReplaces(writer, 'NONE', null), true, 'creates the row when there is none');
    for (const basis of CONTACT_BASES) {
      assert.equal(writeReplaces(writer, 'NONE', { basis, revokedAt: null }), false);
      assert.equal(writeReplaces(writer, 'NONE', { basis, revokedAt: NOW }), false);
    }
  }
});

test('DOI_CONFIRMED needs the click, and only e-mail has a double opt-in', () => {
  assert.equal(refuseWrite({ writer: 'doi', channel: 'EMAIL', basis: 'DOI_CONFIRMED', confirmedAt: NOW }), null);
  assert.equal(refuseWrite({ writer: 'doi', channel: 'EMAIL', basis: 'DOI_CONFIRMED' }), 'doi_needs_confirmation');
  assert.equal(refuseWrite({ writer: 'doi', channel: 'PHONE', basis: 'DOI_CONFIRMED', confirmedAt: NOW }), 'channel_not_email');
  assert.equal(refuseWrite({ writer: 'doi', channel: 'EMAIL', basis: 'INQUIRY_REPLY' }), 'basis_not_allowed_for_writer');
});

test('an admin can never type in a double opt-in, and a §7(3) record needs a reason', () => {
  assert.equal(
    refuseWrite({ writer: 'admin', channel: 'EMAIL', basis: 'DOI_CONFIRMED', confirmedAt: NOW, reason: REASON }),
    'basis_not_allowed_for_writer',
  );
  assert.equal(refuseWrite({ writer: 'admin', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3' }), 'reason_required');
  assert.equal(refuseWrite({ writer: 'admin', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: '  paid  ' }), 'reason_required');
  assert.equal(refuseWrite({ writer: 'admin', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: REASON }), null);
  assert.equal(refuseWrite({ writer: 'admin', channel: 'PHONE', basis: 'EXISTING_CUSTOMER_7_3', reason: REASON }), 'channel_not_email');
  assert.equal(refuseWrite({ writer: 'admin', channel: 'PHONE', basis: 'NONE' }), null);
});

test('an enquiry conversion writes INQUIRY_REPLY, or carries a confirmed DOI over — never a §7(3)', () => {
  assert.equal(refuseWrite({ writer: 'inquiry', channel: 'EMAIL', basis: 'INQUIRY_REPLY' }), null);
  assert.equal(refuseWrite({ writer: 'inquiry', channel: 'EMAIL', basis: 'DOI_CONFIRMED', confirmedAt: NOW }), null);
  assert.equal(refuseWrite({ writer: 'inquiry', channel: 'EMAIL', basis: 'DOI_CONFIRMED' }), 'doi_needs_confirmation');
  assert.equal(
    refuseWrite({ writer: 'inquiry', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: REASON }),
    'basis_not_allowed_for_writer',
  );
});

test('a conversion never downgrades a stronger basis and never revives a revocation; a DOI click does', () => {
  assert.equal(writeReplaces('inquiry', 'INQUIRY_REPLY', { basis: 'NONE', revokedAt: null }), true);
  assert.equal(writeReplaces('inquiry', 'INQUIRY_REPLY', { basis: 'DOI_CONFIRMED', revokedAt: null }), false);
  assert.equal(writeReplaces('inquiry', 'INQUIRY_REPLY', { basis: 'EXISTING_CUSTOMER_7_3', revokedAt: null }), false);
  assert.equal(writeReplaces('inquiry', 'DOI_CONFIRMED', { basis: 'NONE', revokedAt: NOW }), false);
  // The address owner opting back in is a new, explicit consent — a click
  // AFTER the revocation. One dated before it is the revoked consent itself.
  const later = new Date(NOW.getTime() + 1000);
  const earlier = new Date(NOW.getTime() - 1000);
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', { basis: 'NONE', revokedAt: NOW }, later), true);
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', { basis: 'NONE', revokedAt: NOW }, earlier), false);
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', { basis: 'NONE', revokedAt: NOW }), false);
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', { basis: 'INQUIRY_REPLY', revokedAt: null }, earlier), true);
  assert.equal(writeReplaces('admin', 'NONE', { basis: 'DOI_CONFIRMED', revokedAt: null }), true);
});

test('the gate: only a live DOI or §7(3) row for THIS address permits advertising e-mail', () => {
  const doi = { channel: 'EMAIL', basis: 'DOI_CONFIRMED', revokedAt: null, confirmedAt: NOW, address: 'ana@shop.example' };
  assert.equal(marketingEmailAllowed(doi, 'Ana@Shop.example '), true);
  assert.equal(marketingEmailAllowed(doi, 'someone.else@shop.example'), false, 'a confirmation is for its own address');
  assert.equal(marketingEmailAllowed({ ...doi, revokedAt: NOW }, 'ana@shop.example'), false);
  assert.equal(marketingEmailAllowed({ ...doi, confirmedAt: null }, 'ana@shop.example'), false);
  assert.equal(marketingEmailAllowed({ ...doi, basis: 'INQUIRY_REPLY' }, 'ana@shop.example'), false, 'answering a request is not advertising permission');
  assert.equal(marketingEmailAllowed({ ...doi, basis: 'NONE' }, 'ana@shop.example'), false);
  assert.equal(marketingEmailAllowed({ ...doi, channel: 'PHONE' }, 'ana@shop.example'), false);
  assert.equal(marketingEmailAllowed({ ...doi, basis: 'EXISTING_CUSTOMER_7_3', confirmedAt: null }, 'ana@shop.example'), true);
  assert.equal(marketingEmailAllowed(null, 'ana@shop.example'), false);
  assert.equal(marketingEmailAllowed({ ...doi, address: null }, 'ana@shop.example'), false);
});

test('a request can be confirmed only while it is live: ticked, not withdrawn, within the window', () => {
  const live = { requested: true, optedOutAt: null, createdAt: new Date(NOW.getTime() - 60_000) };
  assert.equal(refuseConfirmation(live, NOW), null);
  assert.equal(refuseConfirmation({ ...live, requested: false }, NOW), 'not_requested');
  assert.equal(refuseConfirmation({ ...live, requested: null }, NOW), 'not_requested');
  assert.equal(refuseConfirmation({ ...live, optedOutAt: NOW }, NOW), 'opted_out');
  const old = new Date(NOW.getTime() - (DOI_CONFIRM_WINDOW_DAYS + 1) * 86_400_000);
  assert.equal(refuseConfirmation({ ...live, createdAt: old }, NOW), 'expired');
});

test('the per-recipient cap is one mail per UTC calendar day', () => {
  assert.equal(capDay(new Date('2026-09-29T00:00:00Z')), '2026-09-29');
  assert.equal(capDay(new Date('2026-09-29T23:59:59Z')), '2026-09-29');
  assert.equal(capDay(new Date('2026-09-30T00:00:00Z')), '2026-09-30');
});

test('the import writer only ever records NONE, through the one writer', () => {
  // Structural pin: the account import creates its EMAIL row through
  // recordMachineContactPermission (which hard-codes NONE), and no file but the
  // store writes the table directly.
  const store = readFileSync(new URL('../../src/lib/marketingImportStore.ts', import.meta.url), 'utf8');
  assert.match(store, /recordMachineContactPermission\(tx, \{\s*writer: 'import'/);
  const writer = readFileSync(new URL('../../src/lib/contactPermission.ts', import.meta.url), 'utf8');
  assert.match(writer, /basis: 'NONE', address: input\.address/);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !path.endsWith(join('lib', 'contactPermission.ts'))) {
        if (/\.contactPermission\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    }
  };
  walk(fileURLToPath(new URL('../../src', import.meta.url)));
  assert.deepEqual(offenders, [], 'ContactPermission is written only by src/lib/contactPermission.ts');
});

test('nobody here writes an advertising basis over the address owner’s own withdrawal', () => {
  const withdrawn = { basis: 'DOI_CONFIRMED', revokedAt: NOW, revokedVia: 'LINK' };
  assert.equal(writeReplaces('admin', 'EXISTING_CUSTOMER_7_3', withdrawn), false);
  assert.equal(writeReplaces('inquiry', 'INQUIRY_REPLY', withdrawn), false);
  // The objection LOCKS the row against every admin write: a neutral basis
  // would clear the revocation, and § 7(3) would then pass on the second step.
  for (const basis of ['NONE', 'INQUIRY_REPLY', 'EXISTING_CUSTOMER_7_3']) {
    assert.equal(writeReplaces('admin', basis, withdrawn), false, `admin ${basis} over a LINK withdrawal`);
  }
  // An admin's own revocation is not the person's objection.
  assert.equal(writeReplaces('admin', 'EXISTING_CUSTOMER_7_3', { ...withdrawn, revokedVia: 'ADMIN' }), true);
  // The person themself opting back in — with a click after the objection.
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', withdrawn, new Date(NOW.getTime() + 1)), true);
  assert.equal(writeReplaces('doi', 'DOI_CONFIRMED', withdrawn, new Date(NOW.getTime() - 1)), false);
});
