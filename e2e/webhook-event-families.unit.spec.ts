import { test, expect } from '@playwright/test';
import { WEBHOOK_EVENTS } from '../src/lib/events/catalog';
import { COMPANY_WEBHOOK_EVENTS } from '../src/lib/companyWebhookRule';
import { groupWebhookEvents, webhookEventFamily } from '../src/lib/webhookEventFamilies';

// The admin picker's families (#1998): every public event is placed in a real
// family — a new event that lands in "other" is a red test, not a stray box.

test.describe('webhook event families', { tag: '@smoke' }, () => {
  test('every public event has a family, and grouping keeps every name exactly once', () => {
    for (const name of WEBHOOK_EVENTS) expect(webhookEventFamily(name), name).not.toBe('other');
    const grouped = groupWebhookEvents(WEBHOOK_EVENTS).flatMap((g) => g.events);
    expect([...grouped].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });

  test('the two application events sit in different families, and the company list is all hiring-side', () => {
    expect(webhookEventFamily('application.created')).toBe('pipeline');
    expect(webhookEventFamily('application.stage_changed')).toBe('hiring');
    for (const name of COMPANY_WEBHOOK_EVENTS) expect(['hiring', 'interviews']).toContain(webhookEventFamily(name));
    expect(webhookEventFamily('no.such')).toBe('other');
  });
});
