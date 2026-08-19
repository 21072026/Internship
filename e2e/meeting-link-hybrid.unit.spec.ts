// Unit tests for the hybrid meeting-link routing — pure node, no browser/page.
// (Playwright resolves the tsconfig @/ paths, which node --test cannot.)
//
// The browser suite can't cover the JaaS branch: CI deliberately runs the app
// with no JAAS_* env, so every link the *server* generates there is
// meet.jit.si. These tests exercise generateMeetingLink in-process instead,
// setting fake credentials around each call — nothing is ever signed or sent
// to 8x8, the config only shapes the URL.
import { test, expect } from '@playwright/test';
import { generateMeetingLink } from '@/lib/meetingRoom';
import { freeMeetingFallbackLink, isEmbeddableMeetingLink, parseJaasMeetingLink } from '@/lib/meetingLink';

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

test.describe('generateMeetingLink — hybrid routing (JaaS 1:1, free instance for the rest)', () => {
  test('1:1 meeting gets a JaaS room when the tenant is configured', { tag: '@smoke' }, () => {
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: 1 }));
    expect(link).toMatch(new RegExp(`^https://8x8\\.vc/${FAKE_APP_ID}/InternshipCRM-[0-9a-f]{16}$`));
    // The generated link must round-trip through the strict parser the panel
    // and the call-token endpoint both rely on.
    expect(parseJaasMeetingLink(link)?.appId).toBe(FAKE_APP_ID);
    expect(isEmbeddableMeetingLink(link)).toBe(true);
  });

  test('group meetings stay on the free instance even with a configured tenant', { tag: '@smoke' }, () => {
    for (const inviteeCount of [0, 2, 3, 25]) {
      const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount }));
      expect(link, `inviteeCount=${inviteeCount}`).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
    }
  });

  test('unknown audience (recurring series) stays on the free instance', () => {
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: null }));
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
  });

  test('unconfigured tenant degrades every meeting to the free instance', { tag: '@smoke' }, () => {
    const link = withJaasEnv({}, () => generateMeetingLink({ inviteeCount: 1 }));
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
  });

  test('half-configured tenant counts as off (all three vars or nothing)', () => {
    const link = withJaasEnv({ JAAS_APP_ID: FAKE_ENV.JAAS_APP_ID }, () => generateMeetingLink({ inviteeCount: 1 }));
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\//);
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

  test('a freshly generated 1:1 JaaS link always has a derivable fallback', () => {
    const link = withJaasEnv(FAKE_ENV, () => generateMeetingLink({ inviteeCount: 1 }));
    const fallback = freeMeetingFallbackLink(link);
    expect(fallback).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);
    // Same room name on both hosts — that is what makes the fallback coherent.
    expect(fallback!.split('/').pop()).toBe(link.split('/').pop());
  });
});
