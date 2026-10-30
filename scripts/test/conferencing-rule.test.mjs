// Unit tests for src/lib/conferencingRule.ts (the policy + link validation of
// #2007) and the provider-name helper in src/lib/meetingLink.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkExternalMeetingLink, chooseMeetingLinkSource, conferencingPolicyOf } = await import(
  '../../src/lib/conferencingRule.ts'
);
const { meetingProviderName, isEmbeddableMeetingLink } = await import('../../src/lib/meetingLink.ts');

const OWN = new Set(['interncrm.com', 'preview.interncrm.com', 'marketing.example.test']);
const MAX = 191;

test('a plain https link on a foreign host is accepted as typed', () => {
  const r = checkExternalMeetingLink('https://meet.google.com/abc-defg-hij', OWN, MAX);
  assert.deepEqual(r, { ok: true, url: 'https://meet.google.com/abc-defg-hij' });
  // Surrounding whitespace is dropped, nothing else is normalised.
  assert.deepEqual(checkExternalMeetingLink('  https://zoom.us/j/123?pwd=x  ', OWN, MAX), {
    ok: true,
    url: 'https://zoom.us/j/123?pwd=x',
  });
});

test('http, custom schemes and garbage are refused', () => {
  assert.deepEqual(checkExternalMeetingLink('http://meet.google.com/x', OWN, MAX), { ok: false, reason: 'not_https' });
  assert.deepEqual(checkExternalMeetingLink('javascript:alert(1)', OWN, MAX), { ok: false, reason: 'not_https' });
  assert.deepEqual(checkExternalMeetingLink('not a url', OWN, MAX), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkExternalMeetingLink('', OWN, MAX), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkExternalMeetingLink(null, OWN, MAX), { ok: false, reason: 'invalid' });
});

test('credentials in the authority are refused', () => {
  assert.deepEqual(checkExternalMeetingLink('https://user:pw@zoom.us/j/1', OWN, MAX), { ok: false, reason: 'credentials' });
  assert.deepEqual(checkExternalMeetingLink('https://user@zoom.us/j/1', OWN, MAX), { ok: false, reason: 'credentials' });
});

test('a link back at one of our own hosts is refused — exact match, any case, trailing dot', () => {
  assert.deepEqual(checkExternalMeetingLink('https://interncrm.com/auth/signin', OWN, MAX), { ok: false, reason: 'own_host' });
  assert.deepEqual(checkExternalMeetingLink('https://INTERNCRM.com/x', OWN, MAX), { ok: false, reason: 'own_host' });
  assert.deepEqual(checkExternalMeetingLink('https://interncrm.com./x', OWN, MAX), { ok: false, reason: 'own_host' });
  assert.deepEqual(checkExternalMeetingLink('https://marketing.example.test/', OWN, MAX), { ok: false, reason: 'own_host' });
  // A subdomain nobody serves is not ours — the served set has no wildcard.
  assert.equal(checkExternalMeetingLink('https://evil.interncrm.com/x', OWN, MAX).ok, true);
});

test('a link that would not fit its column is refused before the write', () => {
  const long = `https://teams.microsoft.com/l/meetup-join/${'a'.repeat(200)}`;
  assert.deepEqual(checkExternalMeetingLink(long, OWN, MAX), { ok: false, reason: 'too_long' });
  assert.equal(checkExternalMeetingLink(long, OWN, 2000).ok, true);
});

test('conferencingPolicyOf reads unknown values as BUILTIN', () => {
  assert.equal(conferencingPolicyOf('PREFER_PERSONAL'), 'PREFER_PERSONAL');
  assert.equal(conferencingPolicyOf('REQUIRE_EXTERNAL'), 'REQUIRE_EXTERNAL');
  assert.equal(conferencingPolicyOf('BUILTIN'), 'BUILTIN');
  assert.equal(conferencingPolicyOf('ZOOM_ONLY'), 'BUILTIN');
  assert.equal(conferencingPolicyOf(null), 'BUILTIN');
  assert.equal(conferencingPolicyOf(undefined), 'BUILTIN');
});

test('a pasted link always wins, under every policy', () => {
  for (const policy of ['BUILTIN', 'PREFER_PERSONAL', 'REQUIRE_EXTERNAL', 'GENERATE_PROVIDER']) {
    assert.deepEqual(
      chooseMeetingLinkSource({ policy, pasted: ' https://zoom.us/j/9 ', personal: 'https://meet.google.com/p' }),
      { source: 'pasted', link: 'https://zoom.us/j/9' },
      policy,
    );
  }
});

test('BUILTIN ignores a saved personal room — today’s behaviour is unchanged', () => {
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'BUILTIN', personal: 'https://meet.google.com/p' }), { source: 'builtin' });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'BUILTIN' }), { source: 'builtin' });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'BUILTIN', pasted: '   ' }), { source: 'builtin' });
});

test('PREFER_PERSONAL uses the saved room, and falls back to a built-in room without one', () => {
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'PREFER_PERSONAL', personal: 'https://meet.google.com/p' }), {
    source: 'personal',
    link: 'https://meet.google.com/p',
  });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'PREFER_PERSONAL', personal: null }), { source: 'builtin' });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'PREFER_PERSONAL', personal: '' }), { source: 'builtin' });
});

test('REQUIRE_EXTERNAL uses the saved room, and refuses rather than mint a room of ours', () => {
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'REQUIRE_EXTERNAL', personal: 'https://zoom.us/my/room' }), {
    source: 'personal',
    link: 'https://zoom.us/my/room',
  });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'REQUIRE_EXTERNAL' }), { refused: 'external_link_required' });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'REQUIRE_EXTERNAL', pasted: '', personal: '  ' }), {
    refused: 'external_link_required',
  });
});

test('GENERATE_PROVIDER asks for a generated room only when one can be made, and never refuses (#2009)', () => {
  // Pasted still wins; an available provider comes next — ahead of a saved room.
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'GENERATE_PROVIDER', pasted: 'https://zoom.us/j/1', providerAvailable: true }), {
    source: 'pasted',
    link: 'https://zoom.us/j/1',
  });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'GENERATE_PROVIDER', personal: 'https://zoom.us/my/r', providerAvailable: true }), { source: 'provider' });
  // No connected calendar (or Google failed): exactly PREFER_PERSONAL — the saved room, else ours.
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'GENERATE_PROVIDER', personal: 'https://zoom.us/my/r' }), {
    source: 'personal',
    link: 'https://zoom.us/my/r',
  });
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'GENERATE_PROVIDER', providerAvailable: false }), { source: 'builtin' });
  // The flag means nothing under any other policy.
  assert.deepEqual(chooseMeetingLinkSource({ policy: 'BUILTIN', providerAvailable: true }), { source: 'builtin' });
  assert.equal(conferencingPolicyOf('GENERATE_PROVIDER'), 'GENERATE_PROVIDER');
});

test('meetingProviderName names the common providers and falls back to the hostname', () => {
  assert.equal(meetingProviderName('https://meet.google.com/abc-defg-hij'), 'Google Meet');
  assert.equal(meetingProviderName('https://us02web.zoom.us/j/123'), 'Zoom');
  assert.equal(meetingProviderName('https://zoom.us/my/room'), 'Zoom');
  assert.equal(meetingProviderName('https://teams.microsoft.com/l/meetup-join/x'), 'Microsoft Teams');
  assert.equal(meetingProviderName('https://teams.live.com/meet/1'), 'Microsoft Teams');
  assert.equal(meetingProviderName('https://acme.webex.com/meet/x'), 'Webex');
  assert.equal(meetingProviderName('https://whereby.com/room'), 'Whereby');
  assert.equal(meetingProviderName('https://meet.jit.si/Room'), 'Jitsi');
  assert.equal(meetingProviderName('https://8x8.vc/vpaas-magic-cookie-1/Room'), 'Jitsi');
  assert.equal(meetingProviderName('https://video.example-corp.de/room/1'), 'video.example-corp.de');
  assert.equal(meetingProviderName('not a url'), null);
  assert.equal(meetingProviderName(null), null);
});

test('the embeddable set is untouched by #2007 — a provider link still opens in a tab', () => {
  assert.equal(isEmbeddableMeetingLink('https://meet.google.com/abc'), false);
  assert.equal(isEmbeddableMeetingLink('https://zoom.us/j/1'), false);
  assert.equal(isEmbeddableMeetingLink('https://meet.jit.si/Room'), true);
});
