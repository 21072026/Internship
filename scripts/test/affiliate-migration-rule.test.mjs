// Unit tests for taking over a previous system's affiliate history
// (src/lib/affiliateMigrationRule.ts, docs/affiliate-module.md, #3118).
//
// Run: npm run test:unit
//
// Every file here is SYNTHETIC: invented codes, references and amounts that
// resemble no real programme. A real export never enters this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateMigrationRule.ts imports its siblings without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseDelimited } = await import('../../src/lib/importPreview.ts');
const { readPartners, readPayouts, validateCommissionRow, checkMigration, missingColumns, parseMigrationAmount, sameKey } = await import('../../src/lib/affiliateMigrationRule.ts');

const NOW = new Date('2026-10-01T12:00:00Z');

const PARTNERS = `code;name;email;status;ended_on;paid_total;unpaid_total
1042;Synthetic One;one@example.test;ACTIVE;;35,00;12,50
spark-co;Spark Co;;TERMINATED;2026-06-30;0;7,00
`;
const COMMISSIONS = `partner_code,customer_ref,payment_ref,payment_amount,payment_date,commission_amount,status,due_date,payout_ref
1042,CUST-A,PAY-1,100.00,2026-01-10,20.00,PAID,2026-02-09,PO-1
1042,CUST-A,PAY-2,100.00,2026-02-10,15.00,PAID,2026-03-12,PO-1
1042,CUST-B,PAY-3,50.00,2026-03-01,12.50,APPROVED,,
1042,CUST-B,PAY-4,50.00,2026-04-01,9.99,REJECTED,,
SPARK-CO,CUST-C,PAY-5,70.00,2026-05-05,7.00,PENDING,2026-06-04,
`;
const PAYOUTS = `payout_ref,partner_code,amount,paid_date,bank_reference
PO-1,1042,"35,00",2026-03-20,TRX 0001
`;

function read(partners = PARTNERS, commissions = COMMISSIONS, payouts = PAYOUTS) {
  const p = readPartners(parseDelimited(partners));
  const o = readPayouts(parseDelimited(payouts), NOW);
  const table = parseDelimited(commissions);
  const rows = table.rows.map((r) => validateCommissionRow(r, table.header, NOW));
  return { p, o, rows, valid: rows.filter((r) => r.ok).map((r) => r.value) };
}

test('a consistent synthetic set reads cleanly and reconciles to the cent', () => {
  const { p, o, rows, valid } = read();
  assert.deepEqual([p.issues, o.issues], [[], []]);
  assert.equal(rows.every((r) => r.ok), true);
  const { issues, reconciliation } = checkMigration({ partners: p.partners, commissions: valid, payouts: o.payouts });
  assert.deepEqual(issues, []);
  assert.deepEqual(reconciliation, [
    { code: '1042', expectedPaidMinor: 3500, expectedUnpaidMinor: 1250, paidMinor: 3500, unpaidMinor: 1250, ok: true },
    { code: 'spark-co', expectedPaidMinor: 0, expectedUnpaidMinor: 700, paidMinor: 0, unpaidMinor: 700, ok: true },
  ]);
});

test('codes are kept verbatim; a termination keeps its day, others none', () => {
  const { p } = read();
  assert.deepEqual(p.partners.map((x) => [x.code, x.status, x.noticeEffectiveAt?.toISOString() ?? null, x.contactEmail]), [
    ['1042', 'ACTIVE', null, 'one@example.test'],
    ['spark-co', 'TERMINATED', '2026-06-30T00:00:00.000Z', null],
  ]);
});

test('commissions are taken as recorded; a missing due day is the payment day', () => {
  const { valid } = read();
  const pay3 = valid.find((c) => c.paymentRef === 'PAY-3');
  assert.equal(pay3.amountMinor, 1250);
  assert.equal(pay3.dueAt.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(valid.find((c) => c.paymentRef === 'PAY-4').status, 'REJECTED');
});

test('a one-cent difference blocks the migration', () => {
  const { p, o, valid } = read(PARTNERS.replace('35,00;12,50', '35,00;12,51'));
  const { issues, reconciliation } = checkMigration({ partners: p.partners, commissions: valid, payouts: o.payouts });
  assert.deepEqual(issues, [{ file: 'partners', row: 1, code: 'reconciliation', subject: '1042' }]);
  assert.equal(reconciliation[0].ok, false);
});

test('payouts must hold exactly their commissions, of their own partner', () => {
  const short = read(undefined, undefined, PAYOUTS.replace('"35,00"', '"34,99"'));
  assert.deepEqual(checkMigration({ partners: short.p.partners, commissions: short.valid, payouts: short.o.payouts }).issues, [
    { file: 'payouts', row: 1, code: 'payout_sum', subject: 'PO-1' },
  ]);
  const empty = read(undefined, undefined, PAYOUTS + 'PO-2,1042,1.00,2026-03-21,\n');
  assert.deepEqual(checkMigration({ partners: empty.p.partners, commissions: empty.valid, payouts: empty.o.payouts }).issues, [
    { file: 'payouts', row: 2, code: 'payout_empty', subject: 'PO-2' },
  ]);
  const other = read(undefined, COMMISSIONS.replace('SPARK-CO,CUST-C,PAY-5,70.00,2026-05-05,7.00,PENDING,2026-06-04,', 'SPARK-CO,CUST-C,PAY-5,70.00,2026-05-05,7.00,PAID,2026-06-04,po-1'));
  const codes = checkMigration({ partners: other.p.partners, commissions: other.valid, payouts: other.o.payouts }).issues.map((i) => i.code);
  assert.ok(codes.includes('payout_other_partner'));
});

test('row checks name the column and the issue', () => {
  const bad = `partner_code,customer_ref,payment_ref,payment_amount,payment_date,commission_amount,status,due_date,payout_ref
1042,CUST-A,PAY-9,abc,2026-01-10,1.00,PENDING,,
1042,CUST-A,PAY-10,1.00,2026-02-31,1.00,PENDING,,
1042,CUST-A,PAY-11,1.00,2099-01-01,1.00,PENDING,,
1042,CUST-A,PAY-12,1.00,2026-01-10,1.00,PAID,,
1042,CUST-A,PAY-13,1.00,2026-01-10,1.00,PENDING,,PO-1
1042,CUST-A,PAY-14,1.00,2026-01-10,1.00,UNKNOWN,,
`;
  const { rows } = read(undefined, bad);
  assert.deepEqual(rows.map((r) => (r.ok ? 'ok' : r.reason)), [
    'payment_amount:invalid_amount',
    'payment_date:invalid_date',
    'payment_date:future_date',
    'payout_ref:paid_without_payout',
    'payout_ref:payout_on_unpaid',
    'status:invalid_status',
  ]);
});

test('cross-file duplicates and unknown partners are caught, case-insensitively', () => {
  const partners = PARTNERS + 'SPARK-CO;Again;;ACTIVE;;0;0\n';
  const commissions = COMMISSIONS + '1042,CUST-C,pay-1,1.00,2026-01-10,0,REJECTED,,\nghost,CUST-Z,PAY-99,1.00,2026-01-10,0,REJECTED,,\n';
  const { p, o, valid } = read(partners, commissions);
  const issues = checkMigration({ partners: p.partners, commissions: valid, payouts: o.payouts }).issues;
  assert.deepEqual(
    issues.map((i) => [i.file, i.code, i.subject]),
    [
      ['partners', 'duplicate', 'SPARK-CO'],
      ['commissions', 'duplicate', 'pay-1'],
      ['commissions', 'customer_two_partners', 'CUST-C'],
      ['commissions', 'unknown_partner', 'ghost'],
    ],
  );
});

test('missing columns and bad partner rows stop the file', () => {
  assert.deepEqual(missingColumns('partners', ['code', 'name']), ['paid_total', 'unpaid_total']);
  const { p } = read('code;name;paid_total;unpaid_total;status\nok-1;Name;0;0;TERMINATED\n;No Code;0;0;\nx y;Bad;0;0;\n');
  assert.deepEqual(p.issues.map((i) => [i.row, i.subject, i.code]), [
    [1, 'ended_on', 'ended_on_required'],
    [2, 'code', 'required'],
    [3, 'code', 'invalid_code'],
  ]);
});

test('amounts: only unambiguous shapes are read; anything else is refused, never guessed', () => {
  const ok = {
    '1234': 123_400,
    '19,99': 1_999,
    '19.99': 1_999,
    '19,9': 1_990,
    '0': 0,
    '1.234,56': 123_456,
    '1,234.56': 123_456,
    '1 234,56': 123_456,
    "1'234.56": 123_456,
    '1.234': 123_400,
    '12.345.678,90': 1_234_567_890,
    '19,999': 1_999_900, // three digits after a mark are a thousands group, as in 1.234
  };
  for (const [raw, minor] of Object.entries(ok)) assert.equal(parseMigrationAmount(raw), minor, raw);
  for (const raw of ['100.0000', '1e3', '−5', '-5', '+5', '12abc', '1.234.56', '1,234,5', '1.23.456', '€19', '']) {
    assert.equal(parseMigrationAmount(raw), null, raw);
  }
});

test('keys compare like the database: case, accents and ß', () => {
  assert.equal(sameKey(' Müller '), sameKey('MULLER'));
  assert.equal(sameKey('Straße'), sameKey('strasse'));
  assert.equal(sameKey('pay-é'), sameKey('PAY-E'));
  assert.notEqual(sameKey('pay-1'), sameKey('pay-2'));
  // So an accent-only variant is the same customer — under two partners it is an issue.
  const commissions = COMMISSIONS.replace('SPARK-CO,CUST-C,', 'SPARK-CO,cust-á,') + '1042,CUST-A,PAY-6,1.00,2026-01-10,0,REJECTED,,\n';
  const variant = commissions.replace('1042,CUST-A,PAY-6', '1042,cust-a,PAY-6').replace('SPARK-CO,cust-á,', 'SPARK-CO,CUST-A,');
  const { p, o, valid } = read(undefined, variant);
  const codes = checkMigration({ partners: p.partners, commissions: valid, payouts: o.payouts }).issues.map((i) => [i.code, i.subject]);
  assert.deepEqual(codes, [['customer_two_partners', 'CUST-A']]);
});

test('a row read from a non-UTF-8 file is refused in every file', () => {
  const broken = 'M\uFFFDller';
  const { p, o, rows } = read(
    PARTNERS.replace('Synthetic One', broken),
    COMMISSIONS.replace('CUST-B,PAY-3', `${broken},PAY-3`),
    PAYOUTS.replace('TRX 0001', broken),
  );
  assert.deepEqual(p.issues, [{ file: 'partners', row: 1, code: 'encoding' }]);
  assert.deepEqual(o.issues, [{ file: 'payouts', row: 1, code: 'encoding' }]);
  assert.equal(rows[2].ok ? 'ok' : rows[2].reason, ':encoding');
});

test('an end day on a partner that is not TERMINATED is refused, never dropped', () => {
  const { p } = read('code;name;status;ended_on;paid_total;unpaid_total\nok-1;Active;ACTIVE;2026-12-31;0;0\nok-2;Paused;SUSPENDED;2026-11-30;0;0\nok-3;Ending;TERMINATED;2027-01-31;0;0\n');
  assert.deepEqual(p.issues.map((i) => [i.row, i.subject, i.code]), [
    [1, 'ended_on', 'ended_on_without_termination'],
    [2, 'ended_on', 'ended_on_without_termination'],
  ]);
  // A notice not yet effective is TERMINATED with a future day — accepted.
  assert.equal(p.partners[0].noticeEffectiveAt.toISOString(), '2027-01-31T00:00:00.000Z');
});

test('a payout dated before a payment it pays is refused', () => {
  const early = read(undefined, undefined, PAYOUTS.replace('2026-03-20', '2026-02-01'));
  assert.deepEqual(checkMigration({ partners: early.p.partners, commissions: early.valid, payouts: early.o.payouts }).issues, [
    { file: 'payouts', row: 1, code: 'payout_before_payment', subject: 'PO-1' },
  ]);
});
