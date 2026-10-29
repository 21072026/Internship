// Unit tests for the Core Web Vitals rules (#1593) — no browser, no database.
// Run with BASE_URL=http://localhost:9 to skip the webServer.
import { test, expect } from '@playwright/test';
import { routeTemplate, webVitalsSampleRate } from '../src/lib/webVitalsRule';

test.describe('web vitals rules', { tag: '@smoke' }, () => {
  test('a route template keeps the shape and drops ids, tokens and the query', () => {
    expect(routeTemplate('/admin/candidates/clx9abcdefghijklmnopqrst?tab=cv')).toBe('/admin/candidates/[id]');
    expect(routeTemplate('/portal/meetings/42')).toBe('/portal/meetings/[id]');
    expect(routeTemplate('/auth/reset/' + 'a'.repeat(40))).toBe('/auth/reset/[id]');
    expect(routeTemplate('/mentor/x/0b8f6c2e-1d2a-4c55-9e1f-3a6b7c8d9e0f')).toBe('/mentor/x/[id]');
    expect(routeTemplate('/')).toBe('/');
    expect(routeTemplate('')).toBe('/');
    expect(routeTemplate('https://app.example.test/portal?email=a%40b.test')).toBe('/portal');
  });

  test('the sample rate is off unless it parses to something above zero', () => {
    for (const off of [undefined, '', '0', '-1', 'abc']) expect(webVitalsSampleRate(off)).toBe(0);
    expect(webVitalsSampleRate('0.1')).toBe(0.1);
    expect(webVitalsSampleRate('5')).toBe(1);
  });
});
