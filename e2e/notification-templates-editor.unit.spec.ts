import { test, expect } from '@playwright/test';
import { EMAIL_GROUP_IDS, groupForCategory } from '../src/lib/emailGroups';
import { EVENT_MAIL_CATEGORY } from '../src/lib/notifications/eventMailRule';
import { EDITABLE_EVENTS, checkTemplateDraft, editableEvent, eventsByGroup, mergeTagsFor, samplePayload } from '../src/lib/notifications/templateAdmin';
import { NOTIFICATION_EVENTS } from '../src/lib/notifications/catalog';
import { OUTBOUND_CATEGORIES } from '../src/lib/outboundApprovalRule';

// The template editor's rules (#1719) and the event mail's category — no browser, no database.

test('every e-mail group sends event mail under a category of its own group', { tag: '@smoke' }, () => {
  for (const g of EMAIL_GROUP_IDS) {
    expect(groupForCategory(EVENT_MAIL_CATEGORY[g]), g).toBe(g);
    // A category outbound approval does not know is HELD — every one here must be listed.
    expect(Object.keys(OUTBOUND_CATEGORIES)).toContain(EVENT_MAIL_CATEGORY[g]);
  }
});

test('the editor lists exactly the events that send mail, grouped by their group', { tag: '@smoke' }, () => {
  const mailing = NOTIFICATION_EVENTS.filter((e) => (e.defaultChannels as readonly string[]).includes('email')).map((e) => e.key);
  expect(EDITABLE_EVENTS.map((e) => e.key)).toEqual(mailing);
  expect(eventsByGroup().flatMap((g) => g.events.map((e) => e.key)).sort()).toEqual([...mailing].sort());
  for (const { group, events } of eventsByGroup()) for (const e of events) expect(e.emailGroup).toBe(group);
  // An in-app-only event has nothing to edit.
  const inAppOnly = NOTIFICATION_EVENTS.find((e) => !(e.defaultChannels as readonly string[]).includes('email'));
  if (inAppOnly) expect(editableEvent(inAppOnly.key)).toBeNull();
});

test('the merge-tag helper lists exactly the event params plus the brand tags', { tag: '@smoke' }, () => {
  const def = editableEvent('security.recoveryCodeUsed')!;
  expect(mergeTagsFor(def)).toEqual(['remaining', 'brand.name', 'brand.url', 'recipient.firstName']);
  expect(samplePayload(def)).toEqual({ remaining: '[remaining]' });
});

test('a draft that would fall back at send time is refused at save time', { tag: '@smoke' }, () => {
  const def = editableEvent('security.recoveryCodeUsed')!;
  expect(checkTemplateDraft(def, { subject: '{{remaining}} codes left', body: '<p>Hi {{recipient.firstName}}</p>' })).toBeNull();
  expect(checkTemplateDraft(def, { subject: '   ', body: '<p>x</p>' })).toBe('empty_subject');
  expect(checkTemplateDraft(def, { subject: 'About {{offerAmount}}', body: '<p>x</p>' })).toBe('unknown_subject_tag');
  expect(checkTemplateDraft(def, { subject: 'Hi', body: '<script>alert(1)</script>' })).toBe('empty_body');
  expect(checkTemplateDraft(def, { subject: 'x'.repeat(256), body: '<p>x</p>' })).toBe('too_long');
});
