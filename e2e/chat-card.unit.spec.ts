import { test, expect } from '@playwright/test';
import { slackBlocks, teamsActivity, safeAction } from '@/lib/chat/card';
import { meetingChatCard, meetingChatSubject } from '@/lib/meetingChatCard';

// The chat card shapes (#1942) — no browser, no database. The rule that
// matters: no action, no button. A cancelled meeting's card must not keep a
// "Join" button that still opens the room.

const JOIN = { label: 'Join the meeting', url: 'https://meet.example.test/r' };

test('a card with an action carries one link button on each platform', { tag: '@smoke' }, () => {
  const slack = slackBlocks('Starts soon', JOIN);
  expect(slack).toHaveLength(2);
  expect(slack[1]).toEqual({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: JOIN.label }, url: JOIN.url }] });
  const teams = teamsActivity('Starts soon', JOIN);
  expect(teams.attachments).toEqual([{ contentType: 'application/vnd.microsoft.card.hero', content: { buttons: [{ type: 'openUrl', title: JOIN.label, value: JOIN.url }] } }]);
});

test('no action — or an unsafe one — means no button at all', { tag: '@smoke' }, () => {
  expect(slackBlocks('Cancelled', null)).toHaveLength(1);
  expect(teamsActivity('Cancelled', null).attachments).toEqual([]);
  expect(safeAction({ label: 'x', url: 'http://meet.example.test/r' })).toBeNull();
  expect(safeAction({ label: 'x', url: 'javascript:alert(1)' })).toBeNull();
  expect(safeAction({ label: 'x', url: 'https://u:p@meet.example.test/r' })).toBeNull();
});

test('a meeting card: the batch is the subject, a cancel drops the button and supersedes', { tag: '@smoke' }, () => {
  expect(meetingChatSubject({ id: 'm1', batchKey: 'b1' })).toBe('meeting:b1');
  expect(meetingChatSubject({ id: 'm1', batchKey: null })).toBe('meeting:m1');
  const m = { id: 'm1', batchKey: null, meetLink: 'https://meet.example.test/r' };
  expect(meetingChatCard(m, 'reminder')).toEqual({ subjectKey: 'meeting:m1', actionUrl: m.meetLink, supersede: false });
  expect(meetingChatCard(m, 'moved')).toEqual({ subjectKey: 'meeting:m1', actionUrl: m.meetLink, supersede: true });
  expect(meetingChatCard(m, 'cancelled')).toEqual({ subjectKey: 'meeting:m1', actionUrl: null, supersede: true });
  expect(meetingChatCard({ ...m, meetLink: null }, 'invite').actionUrl).toBeNull();
});
