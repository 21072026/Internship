// The placement ledger's rule (#1765, docs/placements.md).
// Run: node --test --experimental-strip-types scripts/test/placement-rule.test.mjs
//
// What a reviewer cannot keep in their head: the stamp is a reconciliation
// (every delivery order converges), a reversal never deletes, a hire that is
// not ours still gets a non-invoiceable row, and the invoice states move only
// along the table — a reversed hire is never invoiced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICE_STATES,
  canChangeInvoiceState,
  effectiveAttribution,
  initialLedgerState,
  isFeeModel,
  isInvoiceState,
  nextInvoiceStates,
  formatMinor,
  reconcilePlacement,
} from '../../src/lib/placementRule.ts';

const live = { reversedAt: null };
const reversed = { reversedAt: new Date('2026-10-01T00:00:00Z') };

test('reconcile: entering the hire stage creates, or reinstates a reversed row', () => {
  assert.deepEqual(reconcilePlacement({ inHireStage: true, existing: null }), { kind: 'create' });
  assert.deepEqual(reconcilePlacement({ inHireStage: true, existing: reversed }), { kind: 'reinstate' });
  assert.deepEqual(reconcilePlacement({ inHireStage: true, existing: live }), { kind: 'none' });
});

test('reconcile: leaving the hire stage reverses a live row and never deletes', () => {
  assert.deepEqual(reconcilePlacement({ inHireStage: false, existing: live }), { kind: 'reverse' });
  assert.deepEqual(reconcilePlacement({ inHireStage: false, existing: reversed }), { kind: 'none' });
  assert.deepEqual(reconcilePlacement({ inHireStage: false, existing: null }), { kind: 'none' });
  // There is no delete action at all.
  for (const inHireStage of [true, false]) {
    for (const existing of [null, live, reversed]) {
      assert.notEqual(reconcilePlacement({ inHireStage, existing }).kind, 'delete');
    }
  }
});

test('reconcile is idempotent: applying its own result again is a no-op', () => {
  const apply = (state, action) =>
    action.kind === 'create' || action.kind === 'reinstate' ? live : action.kind === 'reverse' ? reversed : state;
  for (const inHireStage of [true, false]) {
    for (const start of [null, live, reversed]) {
      const once = apply(start, reconcilePlacement({ inHireStage, existing: start }));
      assert.deepEqual(reconcilePlacement({ inHireStage, existing: once }), { kind: 'none' });
    }
  }
});

test('attribution: NULL reads as THROUGH_US; a hire that is not ours is never invoiceable', () => {
  assert.equal(effectiveAttribution(null), 'THROUGH_US');
  assert.equal(effectiveAttribution('bogus'), 'THROUGH_US');
  assert.equal(effectiveAttribution('SELF_FOUND'), 'SELF_FOUND');
  assert.deepEqual(initialLedgerState('THROUGH_US'), { invoiceState: 'INVOICEABLE', feeModel: null });
  assert.deepEqual(initialLedgerState('SELF_FOUND'), { invoiceState: 'NOT_INVOICEABLE', feeModel: 'NONE' });
  assert.deepEqual(initialLedgerState('ALREADY_EMPLOYED'), { invoiceState: 'NOT_INVOICEABLE', feeModel: 'NONE' });
});

test('invoice states: only the table moves are allowed', () => {
  const ok = (from, to, extra = {}) => canChangeInvoiceState({ from, to, reversed: false, invoiceRef: 'INV-1', ...extra });
  assert.deepEqual(ok('INVOICEABLE', 'INVOICED'), { ok: true });
  assert.deepEqual(ok('INVOICEABLE', 'WAIVED'), { ok: true });
  assert.deepEqual(ok('INVOICED', 'INVOICEABLE'), { ok: true });
  assert.deepEqual(ok('WAIVED', 'INVOICEABLE'), { ok: true });
  assert.deepEqual(ok('INVOICED', 'WAIVED'), { ok: false, code: 'not_allowed' });
  assert.deepEqual(ok('INVOICEABLE', 'INVOICEABLE'), { ok: false, code: 'same_state' });
  // The attribution's verdict is never overridden by hand.
  for (const to of INVOICE_STATES.filter((s) => s !== 'NOT_INVOICEABLE')) {
    assert.deepEqual(ok('NOT_INVOICEABLE', to), { ok: false, code: 'not_allowed' });
  }
  for (const from of INVOICE_STATES) {
    if (from !== 'NOT_INVOICEABLE') assert.equal(ok(from, 'NOT_INVOICEABLE').ok, false);
  }
});

test('invoice states: INVOICED needs a reference and a live hire', () => {
  assert.deepEqual(canChangeInvoiceState({ from: 'INVOICEABLE', to: 'INVOICED', reversed: false, invoiceRef: '  ' }), {
    ok: false,
    code: 'invoice_ref_required',
  });
  assert.deepEqual(canChangeInvoiceState({ from: 'INVOICEABLE', to: 'INVOICED', reversed: true, invoiceRef: 'INV-1' }), {
    ok: false,
    code: 'reversed',
  });
  // Settling a reversed hire stays possible.
  assert.deepEqual(canChangeInvoiceState({ from: 'INVOICEABLE', to: 'WAIVED', reversed: true }), { ok: true });
  assert.deepEqual(canChangeInvoiceState({ from: 'INVOICED', to: 'INVOICEABLE', reversed: true }), { ok: true });
});

test('nextInvoiceStates offers exactly what canChangeInvoiceState allows', () => {
  for (const from of INVOICE_STATES) {
    for (const rev of [true, false]) {
      const offered = nextInvoiceStates(from, rev);
      for (const to of INVOICE_STATES) {
        const allowed = canChangeInvoiceState({ from, to, reversed: rev, invoiceRef: 'INV-1' }).ok;
        assert.equal(offered.includes(to), allowed, `${from} → ${to} (reversed=${rev})`);
      }
    }
  }
});

test('vocabulary guards', () => {
  assert.ok(isInvoiceState('WAIVED'));
  assert.ok(!isInvoiceState('PAID'));
  assert.ok(isFeeModel('SUCCESS_FEE'));
  assert.ok(!isFeeModel('success_fee'));
});

test('formatMinor uses the currency’s own decimals and never a float', () => {
  assert.equal(formatMinor(123450, 'EUR'), '1234.50 EUR');
  assert.equal(formatMinor(-5, 'EUR'), '-0.05 EUR');
  assert.equal(formatMinor(5000, 'JPY'), '5000 JPY');
  assert.equal(formatMinor(null, 'EUR'), '');
  assert.equal(formatMinor(100, null), '');
});
