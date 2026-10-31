import { test, expect } from '@playwright/test';
import { parseSlackInteraction, parseTeamsInteraction, isSlackResponseUrl } from '../src/lib/chat/interactions/envelope';

// What a chat interaction claims (#1948): only well-formed ids and a known
// action shape are read, and a reply goes only to Slack's own host.

const slack = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
const block = { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, actions: [{ action_id: 'meetings.upcoming', value: 'v' }], response_url: 'https://hooks.slack.com/actions/x' };

test.describe('chat interaction envelope', { tag: '@smoke' }, () => {
  test('a Slack button reads team, member, action and value', () => {
    expect(parseSlackInteraction(slack(block))).toMatchObject({ teamId: 'T1', externalUserId: 'U1', actionId: 'meetings.upcoming', value: 'v' });
  });

  test('anything else from Slack is not an interaction we take', () => {
    expect(parseSlackInteraction('payload=not-json')).toBeNull();
    expect(parseSlackInteraction(slack({ ...block, type: 'view_submission' }))).toBeNull();
    expect(parseSlackInteraction(slack({ ...block, user: { id: 'U1; DROP' } }))).toBeNull();
    expect(parseSlackInteraction(slack({ ...block, actions: [{ action_id: 'Bad Action' }] }))).toBeNull();
    expect(parseSlackInteraction(slack({ ...block, actions: [{ action_id: 'a', value: 'x'.repeat(2001) }] }))).toBeNull();
  });

  test('a Teams Universal Action reads tenant, AAD id and verb', () => {
    const a = { type: 'invoke', name: 'adaptiveCard/action', id: 'a1', from: { aadObjectId: 'aad-1' }, channelData: { tenant: { id: 'tid' } }, value: { action: { verb: 'meetings.upcoming', data: { k: 1 } } } };
    expect(parseTeamsInteraction(a)).toMatchObject({ teamId: 'tid', externalUserId: 'aad-1', actionId: 'meetings.upcoming', value: '{"k":1}' });
    expect(parseTeamsInteraction({ ...a, name: 'composeExtension/query' })).toBeNull();
    expect(parseTeamsInteraction({ ...a, from: { id: '29:x' } })).toBeNull();
  });

  test('a typed note (#1953): Slack input text with the card value as block_id, Teams data.input', () => {
    const typed = { ...block, actions: [{ type: 'plain_text_input', action_id: 'interaction.note.save', block_id: 'row1', value: 'We talked about the CV' }] };
    expect(parseSlackInteraction(slack(typed))).toMatchObject({ actionId: 'interaction.note.save', value: 'row1', input: 'We talked about the CV' });
    expect(parseSlackInteraction(slack(block))).toMatchObject({ input: null });
    // A block_id that is not an id, or text past the limit, is not taken.
    expect(parseSlackInteraction(slack({ ...typed, actions: [{ ...typed.actions[0], block_id: 'row 1;' }] }))).toBeNull();
    expect(parseSlackInteraction(slack({ ...typed, actions: [{ ...typed.actions[0], value: 'x'.repeat(2001) }] }))).toBeNull();
    const a = { type: 'invoke', name: 'adaptiveCard/action', id: 'a1', from: { aadObjectId: 'aad-1' }, channelData: { tenant: { id: 'tid' } }, value: { action: { verb: 'interaction.note.save', data: { value: 'row1', input: 'Notes' } } } };
    expect(parseTeamsInteraction(a)).toMatchObject({ actionId: 'interaction.note.save', value: 'row1', input: 'Notes' });
    expect(parseTeamsInteraction({ ...a, value: { action: { verb: 'interaction.note.save', data: { value: 'row1', input: 'x'.repeat(2001) } } } })).toBeNull();
  });

  test('a reply goes to hooks.slack.com only (loopback behind the e2e switch)', () => {
    expect(isSlackResponseUrl('https://hooks.slack.com/actions/T/1/x')).toBe(true);
    for (const u of ['http://hooks.slack.com/a', 'https://hooks.slack.com.attacker.example/a', 'https://user:pw@hooks.slack.com/a', 'https://hooks.slack.com:8443/a', 'http://127.0.0.1:9/a', null, 'nope']) {
      expect(isSlackResponseUrl(u), String(u)).toBe(false);
    }
    expect(isSlackResponseUrl('http://127.0.0.1:9/a', true)).toBe(true);
  });
});
