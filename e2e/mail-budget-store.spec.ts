import { test, expect } from '@playwright/test';
import { budgetConfig } from '@/lib/mailDeliveryRule';
import { chargeToken, decayPause, pauseBudget, readBudget, spendToken } from '@/lib/mailBudgetStore';
import { getEmailHealth } from '@/lib/emailHealth';
import { prisma } from './helpers/db';

// The shared send budget's SQL half (#2941), against a real database: the pure
// arithmetic is pinned in scripts/test/mail-delivery-rule.test.mjs, and this
// checks that the store's one-statement transitions make the same decisions.
//
// Each run uses its own budget name, so a long-lived dev database (or the real
// 'smtp' row a local server may be metering) is never touched.
const local = !process.env.BASE_URL;
const NAME = `e2e-${Date.now().toString(36)}`;

// One token a minute, burst 2, reserve 1: BULK may spend one token of a fresh
// burst, CRITICAL two.
const cfg = budgetConfig({ MAIL_RATE_PER_MIN: '1', MAIL_BURST: '2', MAIL_URGENT_RESERVE: '1' });

test.afterAll(async () => {
  await prisma.mailBudget.deleteMany({ where: { name: NAME } }).catch(() => {});
  await prisma.$disconnect();
});

test('the budget row: spend, reserve, charge, throttle pause and decay', async () => {
  test.skip(!local, 'reads and writes MailBudget directly — local DB only');

  expect(await readBudget(NAME)).toBeNull();

  // First spend creates the row and is granted.
  expect(await spendToken('BULK', cfg, NAME)).toEqual({ allowed: true, reason: 'spent', waitMs: 0 });
  const created = await readBudget(NAME);
  expect(created?.pauseLevel).toBe(0);

  // The waiting lane is now refused, with an honest wait of about one interval.
  const refused = await spendToken('BULK', cfg, NAME);
  expect(refused.allowed).toBe(false);
  expect(refused.reason).toBe('refused');
  expect(refused.waitMs).toBeGreaterThan(50_000);
  expect(refused.waitMs).toBeLessThanOrEqual(60_000);

  // …but the reserve is still there for CRITICAL, exactly once.
  expect((await spendToken('CRITICAL', cfg, NAME)).allowed).toBe(true);
  expect((await spendToken('CRITICAL', cfg, NAME)).allowed).toBe(false);

  // An observed send the meter did not grant still moves it forward.
  const before = (await readBudget(NAME))!.tat.getTime();
  await chargeToken(cfg, NAME);
  expect((await readBudget(NAME))!.tat.getTime()).toBe(before + cfg.intervalMs);

  // A throttle climbs the ladder; a delivery walks it back down, never below 0.
  await pauseBudget(cfg, NAME);
  await pauseBudget(cfg, NAME);
  const paused = (await readBudget(NAME))!;
  expect(paused.pauseLevel).toBe(2);
  expect(paused.tat.getTime()).toBeGreaterThanOrEqual(before + cfg.intervalMs);
  await decayPause(NAME);
  await decayPause(NAME);
  await decayPause(NAME);
  expect((await readBudget(NAME))!.pauseLevel).toBe(0);
});

test('two concurrent spends of the last token: exactly one wins', async () => {
  test.skip(!local, 'reads and writes MailBudget directly — local DB only');
  const name = `${NAME}-race`;
  try {
    const one = budgetConfig({ MAIL_RATE_PER_MIN: '1', MAIL_BURST: '1', MAIL_URGENT_RESERVE: '0' });
    const results = await Promise.all(Array.from({ length: 6 }, () => spendToken('CRITICAL', one, name)));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
  } finally {
    await prisma.mailBudget.deleteMany({ where: { name } }).catch(() => {});
  }
});

test('e-mail health reports deferred24h beside the failure count', async () => {
  test.skip(!local, 'reads the local EmailLog');
  const health = await getEmailHealth();
  expect(typeof health.deferred24h).toBe('number');
  expect(health.deferred24h).toBeGreaterThanOrEqual(0);
});
