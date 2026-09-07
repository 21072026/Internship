// How a published amount is written (#1730).
//
// Separate from src/lib/plans.ts on purpose: that file decides WHAT we sell and
// for how much, this one only decides how a number is spelled. Keeping them
// apart is what lets the pricing page carry no currency literal of its own —
// the acceptance criterion for #1730 is that grepping the page for a currency
// symbol finds nothing, because every amount arrives already formatted.
//
// PURE: no clock, no locale side-channel, no Intl. Hand-rolled rather than
// `Intl.NumberFormat` because the group separator has to be byte-stable — an
// e2e spec pins a published annual total as a string on the rendered page, and
// ICU builds differ between the Alpine container, the GitHub runner and a
// developer's machine (they also disagree on whether tr-TR writes EUR before
// or after the amount). Three locales, two rules, one unit test.

import type { Locale } from '@/i18n/config';

const EUR = '€';
// A non-breaking space before the trailing symbol: "1.788 €" must never wrap
// onto two lines in a narrow plan column.
const NBSP = ' ';

// en groups with a comma and decimalises with a dot; tr and de do the
// opposite. de and tr both put the symbol after the amount, en before it.
const RULES: Record<Locale, { group: string; decimal: string; symbolFirst: boolean }> = {
  en: { group: ',', decimal: '.', symbolFirst: true },
  tr: { group: '.', decimal: ',', symbolFirst: false },
  de: { group: '.', decimal: ',', symbolFirst: false },
};

function rules(locale: Locale) {
  return RULES[locale] ?? RULES.en;
}

/** Group the integer part of an already-stringified, non-negative number. */
function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function withSymbol(body: string, locale: Locale): string {
  const r = rules(locale);
  return r.symbolFirst ? `${EUR}${body}` : `${body}${NBSP}${EUR}`;
}

/**
 * A whole-EUR amount: `formatEur(1788, 'de')` → `"1.788 €"`.
 *
 * Every published plan price in src/lib/plans.ts is a whole number of euros,
 * so this never prints ",00" — a price column reading "1.788,00 €" spends two
 * characters saying the cents are zero.
 */
export function formatEur(amountEur: number, locale: Locale): string {
  const rounded = Math.round(amountEur);
  const body = group(String(Math.abs(rounded)), rules(locale).group);
  return withSymbol(rounded < 0 ? `-${body}` : body, locale);
}

/**
 * A cent amount, always with both decimals: `formatEurCents(120, 'en')` →
 * `"€1.20"`. Used for the overage rate, which is the one figure on the page
 * below a euro — dropping its decimals would print "€1" for €1.20.
 */
export function formatEurCents(cents: number, locale: Locale): string {
  const r = rules(locale);
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const body = `${group(String(Math.floor(abs / 100)), r.group)}${r.decimal}${String(abs % 100).padStart(2, '0')}`;
  return withSymbol(rounded < 0 ? `-${body}` : body, locale);
}

/**
 * A whole-percent rate from its decimal share: `formatPercent(0.5, 'de')` →
 * `"50 %"`. German and Turkish typography differ here and both are wrong in
 * the other's form — de writes a space before the sign, tr writes the sign
 * first ("%50"), en writes neither.
 */
export function formatPercent(share: number, locale: Locale): string {
  const n = Math.round(share * 100);
  if (locale === 'tr') return `%${n}`;
  if (locale === 'de') return `${n}${NBSP}%`;
  return `${n}%`;
}

/**
 * A small decimal, with the locale's decimal separator and no trailing zero:
 * `formatDecimal(2.5, 'de')` → `"2,5"`, `formatDecimal(2, 'de')` → `"2"`.
 *
 * This exists because the annual saving is also published in months, and that
 * figure is genuinely fractional — Program is 2.5 months free. Routing it
 * through formatCount() instead would round it to 3 and overstate the discount
 * by half a month on a public page, which is the bug this function was added
 * to fix rather than a hypothetical.
 */
export function formatDecimal(value: number, locale: Locale, maxDecimals = 1): string {
  const r = rules(locale);
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(value * factor) / factor;
  const [intPart, decPart] = String(Math.abs(rounded)).split('.');
  const body = decPart ? `${group(intPart, r.group)}${r.decimal}${decPart}` : group(intPart, r.group);
  return rounded < 0 ? `-${body}` : body;
}

/**
 * A count that is either a number or "unlimited" — a plan limit of `null`.
 * The unlimited word is the caller's (it is translated); this only decides how
 * the number itself is grouped, so a 10 000-recipient cap reads correctly in
 * all three locales.
 */
export function formatCount(value: number | null, locale: Locale, unlimitedLabel: string): string {
  if (value == null) return unlimitedLabel;
  return group(String(Math.round(value)), rules(locale).group);
}
