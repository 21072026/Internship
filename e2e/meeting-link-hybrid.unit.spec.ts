// Unit tests for the meeting-link routing — pure node, no browser/page.
// (Playwright resolves the tsconfig @/ paths, which node --test cannot.)
//
// The browser suite can't cover the JaaS branch: CI deliberately runs the app
// with no JAAS_* env, so every link the *server* generates there is
// meet.jit.si. These tests exercise generateMeetingLink in-process instead,
// setting fake credentials around each call — nothing is ever signed or sent
// to 8x8, the config only shapes the URL.
//
// `jaasAllowed` is the decision `resolveMeetingLink` makes from the live
// monthly-participant count (#2011); the arithmetic behind it is covered
// separately below, without a database.
import { test, expect } from '@playwright/test';
import { generateMeetingLink } from '@/lib/meetingRoom';
import {
  DEFAULT_JAAS_MAU_ALLOWANCE,
  UNKNOWN_AUDIENCE_HEAD_COUNT,
  fitsAllowance,
  hashParticipantId,
  jaasMauAllowance,
  projectedHeadCount,
} from '@/lib/jaasAllowance';
import {
  freeMeetingFallbackLink,
  isEmbeddableMeetingLink,
  isFreeInstanceMeetingLink,
  parseJaasMeetingLink,
} from '@/lib/meetingLink';

const FAKE_APP_ID = 'vpaas-magic-cookie-0123456789abcdef0123456789abcdef';
const FAKE_ENV = {
  JAAS_APP_ID: FAKE_APP_ID,
  JAAS_API_KEY_ID: `${FAKE_APP_ID}/ab12cd`,
  // Never used for signing here — jaasConfig() only checks it is PEM-shaped.
  JAAS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----',
} as const;

function withJaasEnv<T>(vars: Partial<Record<keyof typeof FAKE_ENV, string>>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(FAKE_ENV).map((k) => [k, process.env[k]]));
  try {
    for (const key of Object.keys(FAKE_ENV) as (keyof typeof FAKE_ENV)[]) {
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.describe('generateMeetingLink — the allowance decides the host', () => {
  test('a room gets the JaaS tenant when the allowance has room for it', { tag: '@smoke' }, () => {
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: 1, jaasAllowed: true }));
    expect(link).toMatch(new RegExp(`^https://8x8\\.vc/${FAKE_APP_ID}/InternshipCRM-[0-9a-f]{16}$`));
    // The generated link must round-trip through the strict parser the panel
    // and the call-token endpoint both rely on.
    expect(parseJaasMeetingLink(link)?.appId).toBe(FAKE_APP_ID);
    expect(isEmbeddableMeetingLink(link)).toBe(true);
    expect(isFreeInstanceMeetingLink(link)).toBe(false);
  });

  test('a GROUP room gets the tenant too — that is the fix (#2011)', { tag: '@smoke' }, () => {
    // This is the assertion that used to say the opposite. Reserving the tenant
    // for 1:1 calls put every group meeting on a host that hangs up an embedded
    // call after five minutes.
    for (const inviteeCount of [2, 3, 25]) {
      const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount, jaasAllowed: true }));
      expect(link, `inviteeCount=${inviteeCount}`).toMatch(
        new RegExp(`^https://8x8\\.vc/${FAKE_APP_ID}/InternshipCRM-[0-9a-f]{16}$`)
      );
    }
  });

  test('the allowance being spent degrades any room to the free instance', { tag: '@smoke' }, () => {
    // A 1:1 included: over-allowance is an announced degradation, never a call
    // that fails to start.
    for (const inviteeCount of [1, 4, null]) {
      const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount, jaasAllowed: false }));
      expect(link, `inviteeCount=${inviteeCount}`).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
      expect(isFreeInstanceMeetingLink(link)).toBe(true);
    }
  });

  test('a caller that never asked about the allowance cannot spend it', () => {
    // The safe default: no `jaasAllowed` means the public instance.
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: 1 }));
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\//);
  });

  test('unconfigured tenant degrades every meeting to the free instance', { tag: '@smoke' }, () => {
    const link = withJaasEnv({}, () => generateMeetingLink({ inviteeCount: 1, jaasAllowed: true }));
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
  });

  test('half-configured tenant counts as off (all three vars or nothing)', () => {
    const link = withJaasEnv({ JAAS_APP_ID: FAKE_ENV.JAAS_APP_ID }, () =>
      generateMeetingLink({ inviteeCount: 1, jaasAllowed: true })
    );
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\//);
  });
});

test.describe('the allowance arithmetic (#2011)', () => {
  test('a head-count is the invitees plus the organiser', () => {
    expect(projectedHeadCount(1)).toBe(2);
    expect(projectedHeadCount(5)).toBe(6);
    // "Nobody invited" is still one person in a room, never zero heads.
    expect(projectedHeadCount(0)).toBe(2);
    // A recurring series' audience is derived later, so it is booked as a
    // small group rather than as a pair or as the whole organisation.
    expect(projectedHeadCount(null)).toBe(UNKNOWN_AUDIENCE_HEAD_COUNT);
    expect(projectedHeadCount(undefined)).toBe(UNKNOWN_AUDIENCE_HEAD_COUNT);
  });

  test('a room fits only while the whole head-count fits', () => {
    expect(fitsAllowance(20, 2, 25)).toBe(true);
    // Exactly full still fits — the allowance is inclusive.
    expect(fitsAllowance(23, 2, 25)).toBe(true);
    expect(fitsAllowance(24, 2, 25)).toBe(false);
    expect(fitsAllowance(25, 1, 25)).toBe(false);
    // A zero allowance is an operator's kill switch, not a bug.
    expect(fitsAllowance(0, 1, 0)).toBe(false);
  });

  test('the allowance is configuration, with the free tier as the default', () => {
    const saved = process.env.JAAS_MONTHLY_ACTIVE_LIMIT;
    try {
      delete process.env.JAAS_MONTHLY_ACTIVE_LIMIT;
      expect(jaasMauAllowance()).toBe(DEFAULT_JAAS_MAU_ALLOWANCE);
      process.env.JAAS_MONTHLY_ACTIVE_LIMIT = '300';
      expect(jaasMauAllowance()).toBe(300);
      process.env.JAAS_MONTHLY_ACTIVE_LIMIT = '0';
      expect(jaasMauAllowance()).toBe(0);
      // Nonsense falls back rather than silently disabling video routing.
      process.env.JAAS_MONTHLY_ACTIVE_LIMIT = 'lots';
      expect(jaasMauAllowance()).toBe(DEFAULT_JAAS_MAU_ALLOWANCE);
      process.env.JAAS_MONTHLY_ACTIVE_LIMIT = '-4';
      expect(jaasMauAllowance()).toBe(DEFAULT_JAAS_MAU_ALLOWANCE);
    } finally {
      if (saved === undefined) delete process.env.JAAS_MONTHLY_ACTIVE_LIMIT;
      else process.env.JAAS_MONTHLY_ACTIVE_LIMIT = saved;
    }
  });

  test('a participant is stored as a keyed hash, never as an id', () => {
    const hash = hashParticipantId('participant-abc@conference.8x8.vc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Stable — that is what makes the second join of the month a no-op…
    expect(hashParticipantId('participant-abc@conference.8x8.vc')).toBe(hash);
    // …and distinct per person, which is what makes the count a count.
    expect(hashParticipantId('participant-xyz@conference.8x8.vc')).not.toBe(hash);
    // Nothing of the input survives into the stored value.
    expect(hash).not.toContain('participant');
  });
});

test.describe('freeMeetingFallbackLink — same room on the free instance', () => {
  test('derives meet.jit.si/<room> from our own JaaS links only', { tag: '@smoke' }, () => {
    expect(freeMeetingFallbackLink(`https://8x8.vc/${FAKE_APP_ID}/InternshipCRM-1a2b3c4d5e6f7a8b`)).toBe(
      'https://meet.jit.si/InternshipCRM-1a2b3c4d5e6f7a8b'
    );
    // Already free — nothing to fall back to.
    expect(freeMeetingFallbackLink('https://meet.jit.si/InternshipCRM-1a2b3c4d5e6f7a8b')).toBeNull();
    // Pasted third-party links never get a derived fallback.
    expect(freeMeetingFallbackLink('https://zoom.us/j/123456789')).toBeNull();
    expect(freeMeetingFallbackLink('https://meet.google.com/abc-defg-hij')).toBeNull();
    // An 8x8.vc URL that is not one of our tenant links is rejected too.
    expect(freeMeetingFallbackLink('https://8x8.vc/some-other-tenant/room')).toBeNull();
    expect(freeMeetingFallbackLink(`http://8x8.vc/${FAKE_APP_ID}/room`)).toBeNull();
    expect(freeMeetingFallbackLink(null)).toBeNull();
    expect(freeMeetingFallbackLink('')).toBeNull();
  });

  test('a freshly generated JaaS link always has a derivable fallback', () => {
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: 1, jaasAllowed: true }));
    const fallback = freeMeetingFallbackLink(link);
    expect(fallback).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
    // Same room name on both hosts — that is what makes the fallback coherent.
    expect(fallback!.split('/').pop()).toBe(link.split('/').pop());
  });
});

test.describe('isFreeInstanceMeetingLink — who gets the warning', () => {
  test('only rooms on the public host, whatever put them there', () => {
    expect(isFreeInstanceMeetingLink('https://meet.jit.si/InternshipCRM-1a2b3c4d5e6f7a8b')).toBe(true);
    expect(isFreeInstanceMeetingLink(`https://8x8.vc/${FAKE_APP_ID}/InternshipCRM-1a2b`)).toBe(false);
    // A pasted Zoom/Meet link is a room somebody else runs — not ours to warn
    // about, and it has no five-minute cutoff of ours.
    expect(isFreeInstanceMeetingLink('https://zoom.us/j/123456789')).toBe(false);
    expect(isFreeInstanceMeetingLink('https://meet.google.com/abc-defg-hij')).toBe(false);
    expect(isFreeInstanceMeetingLink(null)).toBe(false);
    expect(isFreeInstanceMeetingLink('not a url')).toBe(false);
  });
});
