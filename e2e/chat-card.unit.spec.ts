import { test, expect } from '@playwright/test';
import { slackBlocks, teamsActivity, teamsAdaptiveCard, safeAction } from '@/lib/chat/card';
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
  // The invitee's Yes/No (#1949) ride the invite and a move — never a reminder or a cancel.
  const rsvp = [
    { label: 'rsvpYes', actionId: 'meeting.rsvp.yes', value: 'm1' },
    { label: 'rsvpNo', actionId: 'meeting.rsvp.no', value: 'm1' },
  ];
  expect(meetingChatCard(m, 'invite')).toEqual({ subjectKey: 'meeting:m1', actionUrl: m.meetLink, supersede: false, buttons: rsvp });
  expect(meetingChatCard(m, 'reminder')).toEqual({ subjectKey: 'meeting:m1', actionUrl: m.meetLink, supersede: false, buttons: [] });
  expect(meetingChatCard(m, 'moved')).toEqual({ subjectKey: 'meeting:m1', actionUrl: m.meetLink, supersede: true, buttons: rsvp });
  expect(meetingChatCard(m, 'cancelled')).toEqual({ subjectKey: 'meeting:m1', actionUrl: null, supersede: true, buttons: [] });
  expect(meetingChatCard({ ...m, meetLink: null }, 'invite').actionUrl).toBeNull();
});

test('a card with a text field (#1953): Slack dispatches on Enter, Teams submits with the value', { tag: '@smoke' }, () => {
  const input = { actionId: 'interaction.note.save', value: 'row1', label: 'What was discussed', placeholder: 'Topics…', submitLabel: 'Save notes' };
  const blocks = slackBlocks('Notes for the session', null, null, input);
  expect(blocks[1]).toMatchObject({ type: 'input', block_id: 'row1', dispatch_action: true, element: { type: 'plain_text_input', action_id: 'interaction.note.save', max_length: 2000 } });
  const card = teamsAdaptiveCard('Notes for the session', null, null, input);
  expect(card.body[1]).toMatchObject({ type: 'Input.Text', id: 'input', isMultiline: true, maxLength: 2000 });
  expect(card.actions).toEqual([{ type: 'Action.Execute', title: 'Save notes', verb: 'interaction.note.save', data: { value: 'row1' } }]);
  // A value that could not come back as an id renders no field at all.
  expect(slackBlocks('x', null, null, { ...input, value: 'row 1;' })).toHaveLength(1);
});
