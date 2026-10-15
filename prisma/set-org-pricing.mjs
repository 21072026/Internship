// Operator CLI: set an organization's MARKETING price list (#2927) — the
// `marketingPriceList` setting /pricing and the landing FAQ read for the org
// bound to a marketing host (`Organization.publicHost`).
//
//   node prisma/set-org-pricing.mjs --org <slug|id> --file <price-list.json>           # dry run
//   node prisma/set-org-pricing.mjs --org <slug|id> --file <price-list.json> --apply   # write
//   node prisma/set-org-pricing.mjs --org <slug|id> --clear [--apply]                  # back to "pricing on request"
//   node prisma/set-org-pricing.mjs --org <slug|id>                                    # show what is stored
//
// DRY RUN BY DEFAULT: without --apply it validates the file, prints the list it
// would store next to the one stored today, and writes nothing. A published
// price is the one number on a public page nobody can take back once read.
//
// The file (money in integer MINOR units, a two-decimal ISO currency):
//
//   { "currency": "EUR",
//     "plans": [ { "key": "team", "annualSeatMinor": 4900, "monthlySeatMinor": 5900,
//                  "minSeats": 1, "onboardingMinor": 0 } ] }
//
// `validatePriceList` below is the plain-ESM MIRROR of `priceListSchema` in
// src/lib/marketingPriceListRule.ts (the server runs Node 20, which cannot
// import TypeScript); scripts/test/marketing-price-list.test.mjs runs both over
// one corpus so they cannot drift — change one, change both. What is stored is
// the canonical JSON of the validated list, never the file's own text.
//
// The row written is the ORG's own (`Setting` orgId = the org), never the
// global row: a global price list would be inherited by every bound org.
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

export const PLAN_KEYS = ['team', 'business', 'enterprise'];
export const CURRENCIES = ['EUR', 'CHF', 'GBP', 'USD', 'TRY'];
export const MAX_SEAT_MINOR = 10_000_000;
export const MAX_ONBOARDING_MINOR = 100_000_000;
export const MAX_MIN_SEATS = 10_000;
export const MAX_LENGTH = 4_000;

const SETTING_KEY = 'marketingPriceList';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function onlyKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
}

/** The parsed JSON value → `{ ok, value }` or `{ ok: false, errors }`. Mirrors priceListSchema. */
export function validatePriceList(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['(root): expected an object'] };
  onlyKeys(value, ['currency', 'plans'], '(root)', errors);
  if (!CURRENCIES.includes(value.currency)) errors.push(`currency: one of ${CURRENCIES.join(', ')}`);
  const plans = value.plans;
  if (!Array.isArray(plans)) {
    errors.push('plans: expected an array');
  } else {
    if (plans.length < 1 || plans.length > PLAN_KEYS.length) errors.push(`plans: 1 to ${PLAN_KEYS.length} plans`);
    plans.forEach((p, i) => {
      const where = `plans.${i}`;
      if (!isPlainObject(p)) {
        errors.push(`${where}: expected an object`);
        return;
      }
      onlyKeys(p, ['key', 'annualSeatMinor', 'monthlySeatMinor', 'minSeats', 'onboardingMinor'], where, errors);
      if (!PLAN_KEYS.includes(p.key)) errors.push(`${where}.key: one of ${PLAN_KEYS.join(', ')}`);
      if (!intIn(p.annualSeatMinor, 1, MAX_SEAT_MINOR)) errors.push(`${where}.annualSeatMinor: a whole number 1..${MAX_SEAT_MINOR}`);
      if (p.monthlySeatMinor !== null && !intIn(p.monthlySeatMinor, 1, MAX_SEAT_MINOR)) {
        errors.push(`${where}.monthlySeatMinor: null or a whole number 1..${MAX_SEAT_MINOR}`);
      }
      if (!intIn(p.minSeats, 1, MAX_MIN_SEATS)) errors.push(`${where}.minSeats: a whole number 1..${MAX_MIN_SEATS}`);
      if (!intIn(p.onboardingMinor, 0, MAX_ONBOARDING_MINOR)) errors.push(`${where}.onboardingMinor: a whole number 0..${MAX_ONBOARDING_MINOR}`);
    });
    // Each key once, in key order (the cards stack: "Everything in Team, plus").
    if (errors.length === 0) {
      const order = plans.map((p) => PLAN_KEYS.indexOf(p.key));
      for (let i = 1; i < order.length; i++) {
        if (order[i] <= order[i - 1]) errors.push(`plans.${i}.key: plans are listed once each, in the order ${PLAN_KEYS.join(', ')}`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      currency: value.currency,
      plans: plans.map((p) => ({
        key: p.key,
        annualSeatMinor: p.annualSeatMinor,
        monthlySeatMinor: p.monthlySeatMinor,
        minSeats: p.minSeats,
        onboardingMinor: p.onboardingMinor,
      })),
    },
  };
}

/** Stored/file text → the list, or why not. Mirrors parsePriceList. */
export function parsePriceListText(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, errors: ['empty'] };
  if (text.length > MAX_LENGTH) return { ok: false, errors: [`longer than ${MAX_LENGTH} characters`] };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not JSON'] };
  }
  return validatePriceList(json);
}

const money = (minor, currency) => (minor == null ? '—' : `${(minor / 100).toFixed(2)} ${currency}`);

export function describePriceList(list) {
  return list.plans
    .map(
      (p) =>
        `  ${p.key.padEnd(10)} annual ${money(p.annualSeatMinor, list.currency)}/user/month · ` +
        `monthly ${money(p.monthlySeatMinor, list.currency)} · min ${p.minSeats} users · ` +
        `onboarding ${money(p.onboardingMinor, list.currency)}`,
    )
    .join('\n');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const clear = process.argv.includes('--clear');
  const orgRef = arg('org');
  if (!orgRef) throw new Error('--org <slug|id> is required');
  const file = arg('file');
  if (clear && file) throw new Error('--clear and --file are mutually exclusive');

  // Validate the file before touching the database, so a typo fails fast.
  let next = null;
  if (file) {
    const parsed = parsePriceListText(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error(`the price list in ${file} is not valid:\n  ${parsed.errors.join('\n  ')}`);
    next = parsed.value;
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ id: orgRef }, { slug: orgRef }] },
      select: { id: true, slug: true, vertical: true, publicHost: true },
    });
    if (!org) throw new Error(`No organization with id or slug "${orgRef}"`);
    if (org.vertical !== 'MARKETING') throw new Error(`${org.slug} is a ${org.vertical} organization; a price list is read for MARKETING organizations only`);

    const row = await prisma.setting.findFirst({ where: { orgId: org.id, key: SETTING_KEY }, select: { id: true, value: true } });
    const current = row ? parsePriceListText(row.value) : null;
    console.log(`Organization: ${org.slug} (${org.id}), public host: ${org.publicHost ?? 'none — /pricing shows no price list on any host'}`);
    if (!row || !row.value.trim()) console.log('Stored today: nothing (/pricing shows "pricing on request").');
    else if (current?.ok) console.log(`Stored today:\n${describePriceList(current.value)}`);
    else console.log(`Stored today: a value that does not parse (/pricing shows "pricing on request"): ${current?.errors.join('; ')}`);

    if (!file && !clear) return;

    if (clear) {
      console.log('Would remove the stored list (/pricing shows "pricing on request" again).');
    } else {
      console.log(`Would store:\n${describePriceList(next)}`);
    }
    if (!apply) {
      console.log('Dry run: nothing written. Add --apply to write.');
      return;
    }
    if (clear) {
      if (row) await prisma.setting.delete({ where: { id: row.id } });
      console.log(`Cleared the price list of ${org.slug}.`);
      return;
    }
    const value = JSON.stringify(next);
    if (row) await prisma.setting.update({ where: { id: row.id }, data: { value } });
    else await prisma.setting.create({ data: { orgId: org.id, key: SETTING_KEY, value } });
    console.log(`Stored the price list of ${org.slug}.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a CLI, so the unit test can import the validator.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`set-org-pricing: ${e.message}`);
    process.exit(1);
  });
}
