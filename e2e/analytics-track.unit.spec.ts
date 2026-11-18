import { test, expect } from '@playwright/test';
import { track, ANALYTICS_EVENTS } from '@/lib/track';
import { COOKIE_CONSENT_VERSION } from '@/lib/cookieConsent';
import { configuredProviders } from '@/lib/analytics';

// Compile-time CRM privacy contract. Variables with extra keys must fail too,
// rather than relying on excess-property checking of object literals alone.
if (false) {
  // @ts-expect-error identities are not analytics properties
  track(ANALYTICS_EVENTS.SIGNUP_COMPLETED, { email: 'synthetic@example.test' });
  const bag: Record<string, string | number | boolean> = { email: 'synthetic@example.test' };
  // @ts-expect-error generic property bags cannot cross the analytics boundary
  track(ANALYTICS_EVENTS.SIGNUP_COMPLETED, bag);
  const person = { role: 'mentee' as const, companyId: 'synthetic-company' };
  // @ts-expect-error a variable cannot smuggle an identity alongside an allowed role
  track(ANALYTICS_EVENTS.ROLE_CARD_SELECTED, person);
  // @ts-expect-error arbitrary strings cannot stand in for a finite category
  track(ANALYTICS_EVENTS.ROLE_CARD_SELECTED, { role: 'Synthetic Person' });
  // @ts-expect-error event names cannot carry free text
  track('Synthetic Person signed up');
  // @ts-expect-error phone/name/user identifiers are not allowed either
  track(ANALYTICS_EVENTS.SIGNUP_COMPLETED, { phone: '123', name: 'Synthetic', userId: 'test', menteeId: 'test' });
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
function browser(consent: boolean, providers: object = {}) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: providers });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => JSON.stringify({ version: COOKIE_CONSENT_VERSION, necessary: true, analytics: consent, marketing: false }),
  } });
}
test.afterEach(() => {
  for (const [key, descriptor] of [['window', originalWindow], ['localStorage', originalStorage]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('consent is a hard gate even with all three providers loaded; withdrawal stops later calls', { tag: '@smoke' }, () => {
  const calls: unknown[][] = [];
  const provider = (...args: unknown[]) => { calls.push(args); };
  const globals = { plausible: provider, gtag: provider, posthog: { capture: provider } };
  browser(false, globals);
  expect(track(ANALYTICS_EVENTS.SIGNUP_COMPLETED)).toBe(false);
  expect(calls).toEqual([]);
  browser(true, globals);
  expect(track(ANALYTICS_EVENTS.ROLE_CARD_SELECTED, { role: 'mentor' })).toBe(true);
  expect(calls).toEqual([
    ['role_card_selected', { props: { role: 'mentor' } }],
    ['event', 'role_card_selected', { role: 'mentor', transport_type: 'beacon' }],
    ['role_card_selected', { role: 'mentor' }, { transport: 'sendBeacon' }],
  ]);
  browser(false, globals);
  track(ANALYTICS_EVENTS.SIGNUP_VERIFIED);
  expect(calls).toHaveLength(3);
});

test('missing or throwing globals are silent; a broken provider cannot block another', () => {
  browser(true);
  expect(track(ANALYTICS_EVENTS.FEATURES_VIEWED)).toBe(false);
  const calls: unknown[][] = [];
  browser(true, { plausible: () => { throw new Error('Synthetic vendor failure'); }, gtag: (...args: unknown[]) => calls.push(args) });
  expect(() => track(ANALYTICS_EVENTS.PRICING_VIEWED)).not.toThrow();
  expect(calls).toHaveLength(1);
});

test('runtime allowlist discards identities and invalid values even from untyped callers', () => {
  const calls: unknown[][] = [];
  browser(true, { plausible: (...args: unknown[]) => calls.push(args) });
  const untyped = { role: 'company' as const, email: 'synthetic@example.test', companyId: 'synthetic', placement: 'free text' };
  // Deliberate runtime attack bypassing the compile-time contract.
  track(ANALYTICS_EVENTS.ROLE_CARD_SELECTED, untyped as { role: 'company' });
  expect(calls).toEqual([['role_card_selected', { props: { role: 'company' } }]]);
});

test('provider privacy defaults and off-by-default configuration remain intact', () => {
  expect(configuredProviders({})).toEqual([]);
  const init = configuredProviders({ NEXT_PUBLIC_POSTHOG_KEY: 'synthetic' })[0].snippet.init!;
  let options: unknown;
  init({ posthog: { init: (_key, value) => { options = value; } } });
  expect(options).toMatchObject({ autocapture: false, persistence: 'memory', disable_session_recording: true });
});

test('credential URL cleanup failure drops telemetry without throwing after verification', () => {
  const calls: unknown[][] = [];
  browser(true, {
    plausible: (...args: unknown[]) => calls.push(args),
    location: { search: '?token=synthetic', hash: '', pathname: '/auth/verify' },
    history: { state: null, replaceState: () => { throw new Error('Synthetic browser refusal'); } },
  });
  expect(track(ANALYTICS_EVENTS.SIGNUP_VERIFIED)).toBe(false);
  expect(calls).toEqual([]);
});
