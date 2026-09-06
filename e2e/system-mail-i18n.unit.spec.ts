// The last English-only system mails, now written per recipient (#1720) — pure
// node, no browser, no database.
//
// Same reasoning as e2e/email-groups-footer.unit.spec.ts: the Playwright config
// blanks SMTP_USER, so sendEmail() short-circuits to a SKIPPED EmailLog row
// before it ever builds a MIME part, and EmailLog stores no body. Nothing in
// this repo can inspect a rendered e-mail end to end, so "does the invitation
// arrive in Turkish" is asserted against the dictionary blocks the senders read
// and against the fragments they build, exported through `__testable`.
//
// The second half of the file is a source scan. It is the part that actually
// prevents the regression: a new mail (or a re-edit of an old one) can quietly
// hardcode an English sentence and every runtime test still passes, because
// there is no runtime to fail. The scan names the string and the file instead.
//
// Playwright (not `node --test`) because it resolves the tsconfig `@/` paths.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { __testable } from '@/services/emailService';
import { getDictionary } from '@/i18n/dictionaries';
import { locales, type Locale } from '@/i18n/config';

// unsubscribeFooterHtml (pulled in transitively) mints tokens with
// requireServerSecret(), which throws when NEXTAUTH_SECRET is unset (#870).
process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';

const { resolveLocale, timeZoneNote, inMinutesText, organizerTimeLine, participantClocks, activityDigestTable } =
  __testable;

const SERVICE = path.join(process.cwd(), 'src/services/emailService.ts');
const source = fs.readFileSync(SERVICE, 'utf8');

/** The `notifications.<x>Email` blocks this issue introduced, per locale. */
const MAIL_BLOCKS = [
  'invitationEmail',
  'passwordResetEmail',
  'verificationEmail',
  'meetingInviteEmail',
  'meetingReminderEmail',
  'meetingSeriesReminderEmail',
  'mentorDigestEmail',
  'activityDigestEmail',
  'unreadDigestEmail',
  'emailTimes',
] as const;

type Flat = Record<string, string>;

function flatten(value: unknown, prefix = ''): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flatten(v, key));
    else out[key] = String(v);
  }
  return out;
}

function block(locale: Locale, name: (typeof MAIL_BLOCKS)[number]): Flat {
  return flatten(getDictionary(locale).notifications[name]);
}

/** Every `{token}` in a string, in document order. */
function placeholders(s: string): string[] {
  return [...s.matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort();
}

test.describe('every system mail exists in all three languages', () => {
  for (const name of MAIL_BLOCKS) {
    test(`${name} is complete in en, tr and de`, { tag: '@smoke' }, () => {
      const en = block('en', name);
      const keys = Object.keys(en);
      expect(keys.length, `${name} has no keys`).toBeGreaterThan(0);

      for (const locale of locales) {
        const dict = block(locale, name);
        // Key parity is also enforced by scripts/check-i18n.ts; asserted here so
        // a failure names the mail rather than a flattened dotted path.
        expect(Object.keys(dict).sort(), `${locale}.${name} keys`).toEqual(keys.slice().sort());
        for (const key of keys) {
          expect(dict[key].trim(), `${locale}.${name}.${key} is empty`).not.toBe('');
        }
      }
    });

    test(`${name} interpolates the same tokens in every language`, () => {
      const en = block('en', name);
      for (const locale of locales.filter((l) => l !== 'en')) {
        const dict = block(locale, name);
        for (const key of Object.keys(en)) {
          // The senders interpolate by NAME, so a translation that drops (or
          // invents) a token renders a mail with a literal "{name}" in it — or
          // silently loses the value entirely.
          expect(placeholders(dict[key]), `${locale}.${name}.${key} placeholders`).toEqual(placeholders(en[key]));
        }
      }
    });

    test(`${name} is actually translated, not copied from English`, () => {
      const en = block('en', name);
      // A few one-word labels legitimately coincide across languages ("Mentee",
      // "Login", "Mentor"). What must not happen is a whole block sitting in
      // English under a Turkish or German key, so the assertion is on the bulk
      // of the block rather than on every single string.
      for (const locale of locales.filter((l) => l !== 'en')) {
        const dict = block(locale, name);
        const keys = Object.keys(en);
        const identical = keys.filter((k) => dict[k] === en[k]).length;
        expect(identical, `${locale}.${name}: ${identical}/${keys.length} strings are still the English ones`).toBeLessThan(
          Math.ceil(keys.length / 2),
        );
      }
    });
  }
});

test.describe('a recipient with no preference still gets a working mail', () => {
  test('resolveLocale falls back to the default locale, never to nothing', { tag: '@smoke' }, () => {
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('tr')).toBe('tr');
    expect(resolveLocale('de')).toBe('de');
  });
});

test.describe('the fragments every meeting mail shares follow the body', () => {
  test('the timezone footer is written in the mail\'s language', { tag: '@smoke' }, () => {
    const en = timeZoneNote('Europe/Berlin', 'en');
    const tr = timeZoneNote('Europe/Berlin', 'tr');
    const de = timeZoneNote('Europe/Berlin', 'de');
    for (const html of [en, tr, de]) {
      expect(html).toContain('Europe/Berlin');
      expect(html).toContain('/account#timezone');
      // No unresolved token ever reaches a recipient.
      expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
    }
    expect(tr).not.toBe(en);
    expect(de).not.toBe(en);
    // Omitting the locale keeps the pre-#1720 behaviour for the templates that
    // are still English — a translated footer under an English body is the bug
    // this used to guard against, and it still is.
    expect(timeZoneNote('Europe/Berlin')).toBe(en);
  });

  test('"in about N minutes" has a real singular in each language', () => {
    for (const locale of locales) {
      const one = inMinutesText(1, locale);
      const many = inMinutesText(7, locale);
      expect(one).not.toContain('{n}');
      expect(many).toContain('7');
      expect(one).not.toBe(many);
    }
    expect(inMinutesText(7, 'tr')).not.toBe(inMinutesText(7, 'en'));
    expect(inMinutesText(7, 'de')).not.toBe(inMinutesText(7, 'en'));
  });

  test('the organizer-clock line names the organizer in the reader\'s language', () => {
    const at = new Date('2026-09-10T09:00:00Z');
    const named = organizerTimeLine(at, 'Europe/Istanbul', 'America/New_York', 'Ayşe', 'tr');
    expect(named).toContain('Ayşe');
    expect(named).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(named).not.toBe(organizerTimeLine(at, 'Europe/Istanbul', 'America/New_York', 'Ayşe', 'en'));
    // Same clock on both sides → still silent, in every language.
    expect(organizerTimeLine(at, 'Europe/Berlin', 'Europe/Berlin', 'Ayşe', 'de')).toBe('');
  });

  test('the other-participants list is headed in the reader\'s language', () => {
    const at = new Date('2026-09-10T09:00:00Z');
    const others = [{ name: 'Jonas', timezone: 'Asia/Tokyo' }];
    const de = participantClocks(at, 'Europe/Berlin', others, 'de');
    expect(de).toContain('Jonas');
    expect(de).toContain(getDictionary('de').notifications.emailTimes.others);
    expect(de).not.toBe(participantClocks(at, 'Europe/Berlin', others, 'en'));
  });

  test('the activity digest table headers and login column are translated', () => {
    const items = [
      {
        menteeId: 'm1',
        menteeName: 'Deniz',
        daysSinceLogin: null,
        timeOnSiteSec: 0,
        pageViews: 0,
        goalsCompleted: 0,
        interactions: 0,
        meetings: 0,
        pipelineChanges: 0,
        messagesSent: 0,
        messagesReceived: 0,
      },
      {
        menteeId: 'm2',
        menteeName: 'Lena',
        daysSinceLogin: 3,
        timeOnSiteSec: 120,
        pageViews: 4,
        goalsCompleted: 1,
        interactions: 2,
        meetings: 1,
        pipelineChanges: 0,
        messagesSent: 3,
        messagesReceived: 2,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;

    for (const locale of locales) {
      const A = getDictionary(locale).notifications.activityDigestEmail;
      const html = activityDigestTable(items, locale);
      expect(html).toContain(A.columns.mentee);
      expect(html).toContain(A.columns.onSite);
      // "never" for a mentee who has not signed in yet.
      expect(html).toContain(A.loginNever);
      expect(html).toContain(A.loginDaysAgo.replace('{n}', '3'));
      expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
    }
    expect(activityDigestTable(items, 'tr')).not.toBe(activityDigestTable(items, 'en'));
  });
});

test.describe('no localisable string is left hardcoded in these mails', () => {
  // The exact sentences these mails used to ship. Any of them reappearing in
  // the source means a body (or a subject) went back to being English-only.
  const RETIRED_ENGLISH = [
    'You have been invited to ${brand.name}',
    'Welcome to ${brand.name}',
    'Accept Invitation',
    'Click the button below to complete your registration',
    'Set your password',
    'Reset your password',
    'We received a request to reset your password',
    'Confirm your email',
    'Verify email',
    'Please confirm your email address',
    'Meeting invitation: ${title}',
    "You're invited to a meeting",
    'Can you make it?',
    "Yes, I'll attend",
    "Can't attend",
    'Open the invitation',
    'Reminder: ${m.title} starts soon',
    'Upcoming meeting',
    "'Recurring project meeting'",
    'Open the project',
    'Open the app',
    'Your weekly mentoring summary',
    'Weekly summary',
    'Open dashboard',
    'Daily mentee activity',
    'Open full report',
    'Unread messages',
    'Mark this conversation as read',
    'Times in this email are shown in',
    'For the others:',
  ];

  test('none of the retired English sentences is back in emailService.ts', { tag: '@smoke' }, () => {
    const found = RETIRED_ENGLISH.filter((s) => source.includes(s));
    expect(
      found,
      `These strings must come from src/i18n/dictionaries.ts (notifications.*Email), not from the template:\n  ${found.join('\n  ')}`,
    ).toEqual([]);
  });

  test('every sender that was localised also passes `locale` to sendEmail', { tag: '@smoke' }, () => {
    // The footer and the List-* headers are rendered from sendEmail's own
    // `locale`, so a body translated without it ships a Turkish mail under an
    // English unsubscribe line — half-translated, which #1720 exists to end.
    const CATEGORIES = [
      'invitation',
      'password-reset',
      'verification',
      'meeting-invite',
      'meeting-guest-invite',
      'meeting-reminder',
      'meeting-guest-reminder',
      'meeting-series-reminder',
      'mentor-digest',
      'activity-digest',
      'unread-digest',
    ];
    for (const category of CATEGORIES) {
      // Each send is an object literal; `locale:` sits within a few lines of the
      // `category:` that names it.
      const at = source.indexOf(`category: '${category}'`);
      expect(at, `no send with category '${category}'`).toBeGreaterThan(-1);
      const window = source.slice(at, at + 900);
      expect(window, `the '${category}' send does not pass a locale to sendEmail`).toContain('locale:');
    }
  });

  test('the three digests select preferredLanguage for their recipients', { tag: '@smoke' }, () => {
    // The real bug behind "the digest is always English": these queries never
    // fetched the column, so there was nothing to resolve even after the
    // templates were translated.
    for (const fn of ['sendWeeklyMentorDigests', 'sendDailyActivityDigests', 'sendUnreadMessageDigests']) {
      const at = source.indexOf(`export async function ${fn}(`);
      expect(at, `${fn} not found`).toBeGreaterThan(-1);
      const next = source.indexOf('\nexport async function ', at + 1);
      const body = source.slice(at, next === -1 ? undefined : next);
      expect(body, `${fn} does not select preferredLanguage`).toContain('preferredLanguage: true');
    }
  });

  test('an invitation carries the language its inviter chose', { tag: '@smoke' }, () => {
    // The invitee is the one recipient with no account, so the language cannot
    // be looked up at send time — it is stored on the row and replayed on every
    // resend. If this select or this column goes away, a resend silently reverts
    // to English.
    const invite = fs.readFileSync(path.join(process.cwd(), 'src/lib/inviteCreate.ts'), 'utf8');
    expect(invite).toContain('locale: input.locale ?? null');
    expect(invite).toContain('locale: invitation.locale');

    const resend = fs.readFileSync(path.join(process.cwd(), 'src/app/api/invite/[id]/route.ts'), 'utf8');
    expect(resend).toContain('locale: invite.locale');

    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model InvitationToken {'));
    expect(model.slice(0, model.indexOf('\n}'))).toMatch(/^\s*locale\s+String\?/m);
  });
});
