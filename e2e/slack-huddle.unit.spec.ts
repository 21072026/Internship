// Unit tests for the Slack huddle link helpers (#2879) — pure node, no browser.
// (Playwright resolves the tsconfig @/ paths, which node --test cannot.)
//
// A huddle link is a bring-your-own meeting link (#2007), so the rule it has
// to satisfy is the existing `checkExternalMeetingLink` — the first group
// pins that nothing was relaxed for it. The second group covers the id
// grammar, the third the provider label the UI reads.
import { test, expect } from '@playwright/test';
import { checkExternalMeetingLink } from '@/lib/conferencingRule';
import { isEmbeddableMeetingLink, meetingProviderName, SLACK_HUDDLE_PROVIDER } from '@/lib/meetingLink';
import { buildHuddleUrl, isSlackHuddleLink, parseHuddleUrl } from '@/lib/slackHuddle';

const TEAM = 'T0123ABCD';
const CHANNEL = 'C0456EFGH';
const HUDDLE = `https://app.slack.com/huddle/${TEAM}/${CHANNEL}`;

test.describe('a huddle link passes the bring-your-own-link rule unchanged', () => {
  test('https, no credentials, not our host, fits the column', { tag: '@smoke' }, () => {
    const check = checkExternalMeetingLink(HUDDLE, ['interncrm.com', 'preview.interncrm.com'], 191);
    expect(check).toEqual({ ok: true, url: HUDDLE });
  });

  test('the same refusals apply as to any pasted link', { tag: '@smoke' }, () => {
    expect(checkExternalMeetingLink(`http://app.slack.com/huddle/${TEAM}/${CHANNEL}`, [], 191)).toEqual({ ok: false, reason: 'not_https' });
    expect(checkExternalMeetingLink(`https://bot:x@app.slack.com/huddle/${TEAM}/${CHANNEL}`, [], 191)).toEqual({ ok: false, reason: 'credentials' });
    expect(checkExternalMeetingLink(HUDDLE, ['app.slack.com'], 191)).toEqual({ ok: false, reason: 'own_host' });
    expect(checkExternalMeetingLink(HUDDLE, [], 20)).toEqual({ ok: false, reason: 'too_long' });
  });
});

test.describe('buildHuddleUrl / parseHuddleUrl', () => {
  test('round-trips a valid team + channel pair', { tag: '@smoke' }, () => {
    expect(buildHuddleUrl(TEAM, CHANNEL)).toBe(HUDDLE);
    expect(parseHuddleUrl(HUDDLE)).toEqual({ teamId: TEAM, channelId: CHANNEL });
    // DMs (D…) and private channels / group DMs (G…) have huddles too.
    expect(parseHuddleUrl(buildHuddleUrl(TEAM, 'D0789IJKL')!)).toEqual({ teamId: TEAM, channelId: 'D0789IJKL' });
    expect(parseHuddleUrl(buildHuddleUrl(TEAM, 'G0789IJKL')!)).toEqual({ teamId: TEAM, channelId: 'G0789IJKL' });
  });

  test('refuses ids that are not Slack ids', { tag: '@smoke' }, () => {
    expect(buildHuddleUrl('', CHANNEL)).toBeNull();
    expect(buildHuddleUrl('U0123ABCD', CHANNEL)).toBeNull(); // a user id is not a team
    expect(buildHuddleUrl(TEAM, 'U0456EFGH')).toBeNull(); // nor a conversation
    expect(buildHuddleUrl(TEAM, 'C12')).toBeNull(); // too short to be real
    expect(buildHuddleUrl(TEAM.toLowerCase(), CHANNEL)).toBeNull(); // Slack ids are upper-case
    expect(buildHuddleUrl(`${TEAM}/x`, CHANNEL)).toBeNull(); // nothing that could add a path segment
    expect(buildHuddleUrl(TEAM, `${CHANNEL}?x=1`)).toBeNull();
  });

  test('parses only the huddle link of a channel, nothing else on slack.com', { tag: '@smoke' }, () => {
    expect(parseHuddleUrl(`${HUDDLE}/`)).toEqual({ teamId: TEAM, channelId: CHANNEL });
    expect(parseHuddleUrl(`${HUDDLE}?utm=1`)).toEqual({ teamId: TEAM, channelId: CHANNEL });
    expect(parseHuddleUrl(`  ${HUDDLE}  `)).toEqual({ teamId: TEAM, channelId: CHANNEL });
    expect(parseHuddleUrl(`https://APP.SLACK.COM/huddle/${TEAM}/${CHANNEL}`)).toEqual({ teamId: TEAM, channelId: CHANNEL });

    expect(parseHuddleUrl(null)).toBeNull();
    expect(parseHuddleUrl('')).toBeNull();
    expect(parseHuddleUrl('not a url')).toBeNull();
    expect(parseHuddleUrl(`http://app.slack.com/huddle/${TEAM}/${CHANNEL}`)).toBeNull();
    expect(parseHuddleUrl(`https://acme.slack.com/huddle/${TEAM}/${CHANNEL}`)).toBeNull();
    expect(parseHuddleUrl(`https://app.slack.com/client/${TEAM}/${CHANNEL}`)).toBeNull(); // the channel, not its huddle
    expect(parseHuddleUrl(`https://acme.slack.com/archives/${CHANNEL}/p1700000000000000`)).toBeNull(); // a message permalink
    expect(parseHuddleUrl(`https://app.slack.com/huddle/${TEAM}`)).toBeNull();
    expect(parseHuddleUrl(`https://app.slack.com/huddle/${TEAM}/${CHANNEL}/extra`)).toBeNull();
    expect(parseHuddleUrl(`https://app.slack.com/huddle/${CHANNEL}/${TEAM}`)).toBeNull(); // swapped
    expect(parseHuddleUrl('https://zoom.us/j/123456789')).toBeNull();
    expect(isSlackHuddleLink(HUDDLE)).toBe(true);
    expect(isSlackHuddleLink('https://zoom.us/j/123456789')).toBe(false);
  });
});

test.describe('the provider label the UI reads', () => {
  test('a huddle link is "Slack Huddle", and is never embedded', { tag: '@smoke' }, () => {
    expect(meetingProviderName(HUDDLE)).toBe(SLACK_HUDDLE_PROVIDER);
    expect(meetingProviderName(`${HUDDLE}/`)).toBe(SLACK_HUDDLE_PROVIDER);
    expect(isEmbeddableMeetingLink(HUDDLE)).toBe(false);
  });

  test('anything else on app.slack.com keeps the hostname label, like any unknown link', { tag: '@smoke' }, () => {
    expect(meetingProviderName(`https://app.slack.com/client/${TEAM}/${CHANNEL}`)).toBe('app.slack.com');
    expect(meetingProviderName('https://app.slack.com/')).toBe('app.slack.com');
    expect(meetingProviderName(`https://app.slack.com/huddle/${TEAM}`)).toBe('app.slack.com');
    // The known providers are untouched.
    expect(meetingProviderName('https://zoom.us/j/123456789')).toBe('Zoom');
    expect(meetingProviderName('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
  });
});
