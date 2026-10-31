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

  test('a reply goes to hooks.slack.com only (loopback behind the e2e switch)', () => {
    expect(isSlackResponseUrl('https://hooks.slack.com/actions/T/1/x')).toBe(true);
    for (const u of ['http://hooks.slack.com/a', 'https://hooks.slack.com.attacker.example/a', 'https://user:pw@hooks.slack.com/a', 'https://hooks.slack.com:8443/a', 'http://127.0.0.1:9/a', null, 'nope']) {
      expect(isSlackResponseUrl(u), String(u)).toBe(false);
    }
    expect(isSlackResponseUrl('http://127.0.0.1:9/a', true)).toBe(true);
  });
});
