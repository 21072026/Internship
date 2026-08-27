// Unit tests for the e-mail-group taxonomy and the unsubscribe tokens — pure
// node, no browser, no database. (Playwright resolves the tsconfig `@/` paths,
// which `node --test` cannot; see the warning in e2e/email-hardening.spec.ts.)
//
// Nothing in this repo can inspect a rendered e-mail end to end: the Playwright
// config blanks SMTP_USER, so sendEmail short-circuits to a SKIPPED EmailLog row
// and EmailLog stores no body. The gating rules and the token construction are
// therefore asserted here, against the pure exported functions.
import { test, expect } from '@playwright/test';
import {
  EMAIL_GROUPS,
  EMAIL_GROUP_IDS,
  EMAIL_GROUP_PREF_PREFIX,
  BULK_GROUP_CATEGORIES,
  emailGroupAllowed,
  emailGroupAllowedForCategory,
  emailGroupDef,
  emailGroupPrefKey,
  groupForCategory,
  isBulkGroup,
  isEmailGroupId,
  isEssentialGroup,
  resolveEmailGroupPrefs,
  type EmailGroupId,
} from '@/lib/emailGroups';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';
import {
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  emailPreferencesUrl,
  oneClickUnsubscribeUrl,
} from '@/lib/unsubscribeToken';

// The tokens are HMAC'd with requireServerSecret(), which throws when
// NEXTAUTH_SECRET is unset — the point of #870. Playwright's own env has one,
// but these tests must not depend on which.
process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';

test.describe('the e-mail group taxonomy', () => {
  test('has thirteen groups with unique ids and no category in two of them', () => {
    expect(EMAIL_GROUPS).toHaveLength(13);
    expect(new Set(EMAIL_GROUP_IDS).size).toBe(13);
    expect(EMAIL_GROUP_IDS).toEqual(EMAIL_GROUPS.map((g) => g.id));

    const seen = new Set<string>();
    for (const group of EMAIL_GROUPS) {
      expect(group.categories.length, `${group.id} has categories`).toBeGreaterThan(0);
      for (const category of group.categories) {
        expect(seen.has(category), `${category} appears twice`).toBe(false);
        seen.add(category);
        // Every category round-trips back to its own group.
        expect(groupForCategory(category), category).toBe(group.id);
      }
    }
  });

  test('every legacy key is a real in-app category, and may cover several groups', () => {
    // Uniqueness is asserted for CATEGORIES (above) and deliberately NOT for
    // legacy keys: the eleven old in-app keys were coarse catch-alls, and one of
    // them genuinely suppressed several of the new groups — 'digest' was the only
    // switch both a KPI report and a company-need alert ever had. A uniqueness
    // assertion here would encode exactly the bug #1456 fixed, where a key
    // guarding one group's send sites was mapped to another group's switch.
    // What must hold instead: every listed key is a real category (a typo would
    // silently make rule 5 a no-op, since prefs[typo] is never `false`).
    const used = new Set<string>();
    for (const group of EMAIL_GROUPS) {
      for (const key of group.legacy) {
        expect(NOTIFICATION_CATEGORIES as readonly string[], `${group.id}.legacy`).toContain(key);
        used.add(key);
      }
    }
    // Teeth against an empty or accidentally-cleared taxonomy.
    expect(used.size).toBeGreaterThan(8);
    // At least one key must span groups, or the mapping has drifted back to a
    // one-key-one-group shape the old call sites already proved wrong.
    const spanning = [...used].filter((k) => EMAIL_GROUPS.filter((g) => (g.legacy as readonly string[]).includes(k)).length > 1);
    expect(spanning.sort()).toEqual(['digest', 'meetingReminders', 'mentorship', 'messages']);
  });

  test('exactly one group is essential, and the bulk set matches it', () => {
    const essential = EMAIL_GROUPS.filter((g) => g.essential).map((g) => g.id);
    expect(essential).toEqual(['account_security']);
    expect(isEssentialGroup('account_security')).toBe(true);
    expect(isEssentialGroup('digests')).toBe(false);
    expect(isBulkGroup('digests')).toBe(true);
    expect(isBulkGroup('direct_messages')).toBe(false);

    // BULK_GROUP_CATEGORIES is what emailService derives its SMTP channel split
    // from, so it must be exactly the categories of the bulk:true groups.
    const expected = EMAIL_GROUPS.filter((g) => g.bulk).flatMap((g) => [...g.categories]);
    expect([...BULK_GROUP_CATEGORIES].sort()).toEqual(expected.sort());
    // 'verification' and 'message' must never ride the bulk relay
    // (e2e/email-channels.spec.ts asserts the same thing end to end).
    expect(BULK_GROUP_CATEGORIES).not.toContain('verification');
    expect(BULK_GROUP_CATEGORIES).not.toContain('message');
  });

  test('groupForCategory is null for nothing and for the unknown', () => {
    expect(groupForCategory(undefined)).toBeNull();
    expect(groupForCategory(null)).toBeNull();
    expect(groupForCategory('')).toBeNull();
    expect(groupForCategory('not-a-category')).toBeNull();
  });

  test('isEmailGroupId / emailGroupDef / emailGroupPrefKey', () => {
    expect(isEmailGroupId('digests')).toBe(true);
    expect(isEmailGroupId('email:digests')).toBe(false);
    expect(isEmailGroupId('all')).toBe(false);
    expect(isEmailGroupId(42)).toBe(false);
    expect(isEmailGroupId(undefined)).toBe(false);
    expect(emailGroupDef('digests').id).toBe('digests');
    expect(() => emailGroupDef('nope' as EmailGroupId)).toThrow();
    expect(emailGroupPrefKey('digests')).toBe('email:digests');
    expect(EMAIL_GROUP_PREF_PREFIX).toBe('email:');
  });
});

test.describe('emailGroupAllowed — the six resolution rules', () => {
  test('RULE 1: essential mail ignores every switch, including its own key', () => {
    expect(emailGroupAllowed({ emailNotifications: false }, 'account_security')).toBe(true);
    expect(
      emailGroupAllowed(
        { emailNotifications: false, notificationPrefs: { 'email:account_security': false } },
        'account_security'
      )
    ).toBe(true);
  });

  test('RULE 2: the master switch denies a non-essential group', () => {
    expect(emailGroupAllowed({ emailNotifications: false }, 'digests')).toBe(false);
    // …and it wins even over an explicit opt-in for that group.
    expect(
      emailGroupAllowed({ emailNotifications: false, notificationPrefs: { 'email:digests': true } }, 'digests')
    ).toBe(false);
  });

  test('RULE 3: an explicit group opt-out denies', () => {
    expect(emailGroupAllowed({ notificationPrefs: { 'email:digests': false } }, 'digests')).toBe(false);
    // and only that group
    expect(emailGroupAllowed({ notificationPrefs: { 'email:digests': false } }, 'task_reminders')).toBe(true);
  });

  test('RULE 4: an explicit group opt-in beats a stale legacy opt-out', () => {
    expect(
      emailGroupAllowed({ notificationPrefs: { 'email:digests': true, digest: false } }, 'digests')
    ).toBe(true);
  });

  test('RULE 5: a legacy in-app opt-out still suppresses the group it used to', () => {
    expect(emailGroupAllowed({ notificationPrefs: { deadlines: false } }, 'task_reminders')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { documents: false } }, 'task_reminders')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { mentorship: false } }, 'mentorship_lifecycle')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { stageUpdates: false } }, 'pipeline_updates')).toBe(false);
    // A coarse legacy key can suppress SEVERAL groups, and 'meetingReminders' is
    // the one that does it most visibly. It used to be asserted here as
    // suppressing meeting_reminders and NOT meeting_invites — which read well but
    // encoded the bug in #1456: the three invite send sites all guarded on this
    // key, so the invitation was dropped anyway while the preference surfaces
    // showed meeting_invites as ON. The key now covers both groups, so the
    // suppression is the truth the surfaces tell.
    expect(emailGroupAllowed({ notificationPrefs: { meetingReminders: false } }, 'meeting_reminders')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { meetingReminders: false } }, 'meeting_invites')).toBe(false);
    // …and it stops there: a key is listed on the groups whose mail it really
    // guarded, not on everything.
    expect(emailGroupAllowed({ notificationPrefs: { meetingReminders: false } }, 'direct_messages')).toBe(true);
    // The same shape for the other coarse keys the audit turned up.
    expect(emailGroupAllowed({ notificationPrefs: { mentorship: false } }, 'pipeline_updates')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { mentorship: false } }, 'inbound_requests')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { messages: false } }, 'inbound_requests')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { messages: false } }, 'digests')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { digest: false } }, 'opportunities')).toBe(false);
    expect(emailGroupAllowed({ notificationPrefs: { digest: false } }, 'reports_analytics')).toBe(false);
    // Rule 4 still wins over every one of them — that is what makes listing a
    // key here a preference rather than a wall.
    expect(
      emailGroupAllowed({ notificationPrefs: { meetingReminders: false, 'email:meeting_invites': true } }, 'meeting_invites')
    ).toBe(true);
  });

  test('RULE 6: anything unrecognisable in the JSON column defaults to ON', () => {
    for (const prefs of [{}, null, undefined, 'garbage', [], 0, ['digest']]) {
      expect(emailGroupAllowed({ notificationPrefs: prefs }, 'digests'), JSON.stringify(prefs)).toBe(true);
    }
  });

  test('emailGroupAllowedForCategory fails open on an unknown category', () => {
    expect(emailGroupAllowedForCategory({ notificationPrefs: { 'email:digests': false } }, 'unread-digest')).toBe(false);
    expect(emailGroupAllowedForCategory({ notificationPrefs: { 'email:digests': false } }, 'password-reset')).toBe(true);
    expect(emailGroupAllowedForCategory({ emailNotifications: false }, 'brand-new-category')).toBe(true);
    expect(emailGroupAllowedForCategory({ emailNotifications: false }, undefined)).toBe(true);
  });
});

test.describe('resolveEmailGroupPrefs — the UI-facing resolver', () => {
  test('ignores the master switch so no choice is lost while e-mail is off', () => {
    const resolved = resolveEmailGroupPrefs({
      emailNotifications: false,
      notificationPrefs: { 'email:digests': false, mentorship: false },
    });
    expect(Object.keys(resolved)).toHaveLength(13);
    expect(resolved.account_security).toBe(true);
    expect(resolved.digests).toBe(false);
    expect(resolved.mentorship_lifecycle).toBe(false);
    // 'mentorship' is a coarse legacy key: it also guarded the offer mails and
    // the project-join request, so it reads OFF for those groups too. That is the
    // point of #1456 — the surfaces show every group the key really silences.
    expect(resolved.pipeline_updates).toBe(false);
    expect(resolved.inbound_requests).toBe(false);
    // Groups it never guarded are still ON, not collapsed to off.
    expect(resolved.task_reminders).toBe(true);
    expect(resolved.direct_messages).toBe(true);
  });

  test('an empty blob resolves every group to ON', () => {
    const resolved = resolveEmailGroupPrefs({ notificationPrefs: null });
    expect(Object.values(resolved).every(Boolean)).toBe(true);
  });
});

test.describe('unsubscribe tokens', () => {
  test('round-trip a group token and a preference-centre token', () => {
    expect(verifyUnsubscribeToken(makeUnsubscribeToken('user_1', 'digests'))).toEqual({
      userId: 'user_1',
      group: 'digests',
    });
    expect(verifyUnsubscribeToken(makeUnsubscribeToken('user_1', 'all'))).toEqual({
      userId: 'user_1',
      group: 'all',
    });
    // Every group id survives the round trip.
    for (const id of EMAIL_GROUP_IDS) {
      expect(verifyUnsubscribeToken(makeUnsubscribeToken('u', id))?.group, id).toBe(id);
    }
  });

  test('rejects a tampered, swapped, foreign or empty token', () => {
    const token = makeUnsubscribeToken('user_1', 'digests');
    const [payload, sig] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];

    // A flipped signature character.
    const flipped = sig[0] === 'a' ? `b${sig.slice(1)}` : `a${sig.slice(1)}`;
    expect(verifyUnsubscribeToken(`${payload}.${flipped}`)).toBeNull();
    // The group swapped under a signature minted for another group.
    expect(verifyUnsubscribeToken(`u~user_1~task_reminders.${sig}`)).toBeNull();
    // The user swapped.
    expect(verifyUnsubscribeToken(`u~user_2~digests.${sig}`)).toBeNull();
    // A validly *signed* payload naming a group that does not exist.
    expect(verifyUnsubscribeToken(makeUnsubscribeToken('user_1', 'nope' as EmailGroupId))).toBeNull();
    // Not a token at all, and an emailActionToken-shaped one.
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('nodot')).toBeNull();
    expect(verifyUnsubscribeToken('.abc')).toBeNull();
    expect(verifyUnsubscribeToken('k~rel_1~user_1~zzz.0123456789abcdef0123456789abcdef')).toBeNull();
    // An empty user id must never verify — it would address "no user".
    expect(verifyUnsubscribeToken(makeUnsubscribeToken('', 'digests'))).toBeNull();
  });

  test('a token minted for one group cannot act on another user', () => {
    const mine = makeUnsubscribeToken('user_1', 'digests');
    const theirs = makeUnsubscribeToken('user_2', 'digests');
    expect(mine).not.toBe(theirs);
    expect(verifyUnsubscribeToken(mine)?.userId).toBe('user_1');
    expect(verifyUnsubscribeToken(theirs)?.userId).toBe('user_2');
  });

  test('the URL builders point at the page, and the one-click route at the API', () => {
    // The e2e env leaves NEXT_PUBLIC_APP_URL unset, so the default applies.
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    try {
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(unsubscribeUrl('user_1', 'digests').startsWith('http://localhost:3000/u/')).toBe(true);
      expect(emailPreferencesUrl('user_1').startsWith('http://localhost:3000/u/')).toBe(true);
      expect(oneClickUnsubscribeUrl('user_1', 'digests')).toContain('/api/unsubscribe/one-click?t=');

      // The token in the path survives a decode back to a verifiable token.
      const path = new URL(unsubscribeUrl('user_1', 'digests')).pathname;
      const token = decodeURIComponent(path.slice('/u/'.length));
      expect(verifyUnsubscribeToken(token)).toEqual({ userId: 'user_1', group: 'digests' });

      // …and so does the one in the query string.
      const t = new URL(oneClickUnsubscribeUrl('user_1', 'announcements')).searchParams.get('t');
      expect(verifyUnsubscribeToken(t ?? '')).toEqual({ userId: 'user_1', group: 'announcements' });

      // The preference-centre link is scoped to 'all' and switches nothing off
      // by itself — the API refuses to act on it without an explicit action.
      const prefsToken = decodeURIComponent(new URL(emailPreferencesUrl('user_1')).pathname.slice('/u/'.length));
      expect(verifyUnsubscribeToken(prefsToken)?.group).toBe('all');

      process.env.NEXT_PUBLIC_APP_URL = 'https://crm.ersah.in';
      expect(unsubscribeUrl('user_1', 'digests').startsWith('https://crm.ersah.in/u/')).toBe(true);
      expect(oneClickUnsubscribeUrl('user_1', 'digests').startsWith('https://crm.ersah.in/api/unsubscribe/one-click?t=')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  });
});
