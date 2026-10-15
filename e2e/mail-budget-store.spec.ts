import { test, expect } from '@playwright/test';
import nodemailer from 'nodemailer';
import { budgetConfig } from '@/lib/mailDeliveryRule';
import { chargeToken, decayPause, pauseBudget, readBudget, spendToken } from '@/lib/mailBudgetStore';
import { createMeterObserver } from '@/lib/mailMeterObserver';
import { sendPrepared, type PreparedEmail } from '@/services/emailService';
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

// ── The observer beside a real send ─────────────────────────────────────────
// The send path runs through `sendPrepared()` with a JSON transport (nodemailer's
// own, no network) and a meter on this run's own budget row, so it exercises the
// exact code `sendEmail()` runs after `prepareEmail()` without an SMTP server.

function prepared(to: string, i: number): PreparedEmail {
  return {
    to,
    subject: `meter e2e ${i}`,
    category: 'digest',
    transport: 'primary',
    lane: 'BULK',
    message: { from: 'noreply@example.com', to, subject: `meter e2e ${i}`, text: 'x' },
  };
}

const jsonTransport = nodemailer.createTransport({ jsonTransport: true });

test('observe mode: sends beyond the burst all go out, and the meter is charged for each', async () => {
  test.skip(!local, 'reads and writes MailBudget and EmailLog directly — local DB only');
  const name = `${NAME}-observe`;
  const to = `meter-observe-${Date.now().toString(36)}@example.com`;
  const env = { MAIL_RATE_PER_MIN: '1', MAIL_BURST: '1', MAIL_URGENT_RESERVE: '1', MAIL_METER_MODE: 'observe' };
  const observer = createMeterObserver({ env, nameFor: () => name });
  try {
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => sendPrepared(prepared(to, i), { via: jsonTransport, observer })),
    );
    expect(results).toEqual(Array(N).fill('SENT'));
    await observer.idle();
    expect(await prisma.emailLog.count({ where: { to, status: 'SENT' } })).toBe(N);
    // Every send moved the meter one interval, refused or not.
    const row = (await readBudget(name))!;
    const aheadMs = row.tat.getTime() - Date.now();
    expect(aheadMs).toBeGreaterThan((N - 1) * 60_000);
    expect(aheadMs).toBeLessThanOrEqual(N * 60_000 + 1_000);
  } finally {
    await prisma.emailLog.deleteMany({ where: { to } }).catch(() => {});
    await prisma.mailBudget.deleteMany({ where: { name } }).catch(() => {});
  }
});

test('observe mode: a meter that fails, or is switched off, never stops a send', async () => {
  test.skip(!local, 'reads and writes MailBudget and EmailLog directly — local DB only');
  const name = `${NAME}-off`;
  const to = `meter-off-${Date.now().toString(36)}@example.com`;
  const off = createMeterObserver({ env: { MAIL_METER_MODE: 'off' }, nameFor: () => name });
  const boom = async (): Promise<never> => {
    throw new Error('meter down');
  };
  const broken = createMeterObserver({
    env: { MAIL_RATE_PER_MIN: '1', MAIL_BURST: '1' },
    nameFor: () => name,
    store: { spendToken: boom, chargeToken: boom, pauseBudget: boom, decayPause: boom },
  });
  try {
    expect(await sendPrepared(prepared(to, 0), { via: jsonTransport, observer: off })).toBe('SENT');
    expect(await sendPrepared(prepared(to, 1), { via: jsonTransport, observer: broken })).toBe('SENT');
    await Promise.all([off.idle(), broken.idle()]);
    expect(await prisma.emailLog.count({ where: { to, status: 'SENT' } })).toBe(2);
    // `off` touched nothing, and the broken store never got as far as a row.
    expect(await readBudget(name)).toBeNull();
  } finally {
    await prisma.emailLog.deleteMany({ where: { to } }).catch(() => {});
    await prisma.mailBudget.deleteMany({ where: { name } }).catch(() => {});
  }
});

test('observe mode: meter work runs one at a time and a burst past the backlog is dropped', async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const slow = async () => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return { allowed: true, reason: 'spent' as const, waitMs: 0 };
  };
  const observer = createMeterObserver({
    env: {},
    nameFor: () => `${NAME}-stub`,
    maxBacklog: 4,
    store: { spendToken: slow, chargeToken: async () => {}, pauseBudget: async () => {}, decayPause: async () => false },
  });
  for (let i = 0; i < 50; i++) observer.spend({ lane: 'BULK', category: 'digest', transport: 'primary' });
  await observer.idle();
  expect(peak).toBe(1);
  expect(calls).toBe(4);
  // A delivery with no pause seen costs no statement at all.
  observer.outcome({ lane: 'BULK', category: 'digest', transport: 'primary' }, null);
  await observer.idle();
  expect(calls).toBe(4);
});
