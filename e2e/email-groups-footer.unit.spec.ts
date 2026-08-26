// Unit tests for the unsubscribe FOOTER, the RFC 8058 headers and the SMTP
// channel split — pure node, no browser, no database.
//
// This is the spec the comments in src/services/emailService.ts point at, and it
// exists because nothing in this repo can inspect a rendered e-mail end to end:
// the Playwright config blanks SMTP_USER, so sendEmail() short-circuits to a
// SKIPPED EmailLog row before it ever builds a MIME part, and EmailLog stores no
// body. The only way to assert "does a digest carry a working opt-out and does a
// password reset carry none" is against the string builders directly, which is
// why they are exported through `__testable`.
//
// Playwright (not `node --test`) because it resolves the tsconfig `@/` paths —
// the same reason given in e2e/email-hardening.spec.ts.
import { test, expect } from '@playwright/test';
import { __testable } from '@/services/emailService';
import {
  EMAIL_GROUPS,
  emailGroupAllowedForCategory,
  emailGroupDef,
  groupForCategory,
  isBulkGroup,
  resolveEmailGroupPrefs,
  type EmailGroupId,
} from '@/lib/emailGroups';
import { NOTIFICATION_CATEGORIES, emailAllowed, type NotificationCategory } from '@/lib/notificationPrefs';
import { verifyUnsubscribeToken } from '@/lib/unsubscribeToken';
import fs from 'node:fs';
import path from 'node:path';

// The footer mints tokens with requireServerSecret(), which throws when
// NEXTAUTH_SECRET is unset (#870). Playwright's own env has one; these tests
// must not depend on which.
process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';

const {
  UNSUB_FOOTER_MARKER,
  BULK_CATEGORIES,
  LEGACY_BULK_CHANNEL,
  unsubscribable,
  unsubscribeFooterHtml,
  withUnsubscribeFooter,
  unsubscribeHeaders,
  htmlToText,
} = __testable;

/** Every href in a fragment, in document order. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

test.describe('who gets the consent machinery at all', () => {
  // sendEmail() computes this once and uses the answer for all three of the
  // preference check, the footer and the headers, so this predicate IS the
  // "essential mail carries no opt-out" guarantee.
  test('an essential group gets no footer and no List-* headers, ever', () => {
    for (const g of EMAIL_GROUPS.filter((x) => x.essential)) {
      expect(unsubscribable(g.id, 'user_1'), g.id).toBe(false);
    }
    // Every other group does, given a recipient we can identify.
    for (const g of EMAIL_GROUPS.filter((x) => !x.essential)) {
      expect(unsubscribable(g.id, 'user_1'), g.id).toBe(true);
    }
  });

  test('a recipient who is not a User row gets none either', () => {
    // A mentor applicant, an invitee who has not registered, ALERT_EMAIL_TO, an
    // operator-typed test address: no preference to read, no token to mint.
    for (const userId of [undefined, null, '']) {
      expect(unsubscribable('digests', userId), String(userId)).toBe(false);
    }
  });

  test('an unmapped category fails open rather than being silently gated', () => {
    // A taxonomy gap must never swallow mail somebody is waiting for; it just
    // means no footer until the category is given a group.
    expect(unsubscribable(null, 'user_1')).toBe(false);
    expect(unsubscribable(groupForCategory('brand-new-category'), 'user_1')).toBe(false);
  });
});

test.describe('the unsubscribe footer', () => {
  test('carries both links, and the group link resolves to that user and group', () => {
    const footer = unsubscribeFooterHtml('user_1', 'digests');
    const [unsub, manage] = hrefs(footer);

    // Link 1: unsubscribe from THIS group. It must point at the /u page, not at
    // an API route — mail clients and link scanners GET every URL in a message,
    // and a mutating GET would opt people out who never clicked.
    expect(unsub).toContain('/u/');
    expect(verifyUnsubscribeToken(decodeURIComponent(new URL(unsub).pathname.slice('/u/'.length)))).toEqual({
      userId: 'user_1',
      group: 'digests',
    });

    // Link 2: the preference centre, scoped to 'all' so that clicking "manage my
    // preferences" shows the switches instead of throwing them.
    expect(verifyUnsubscribeToken(decodeURIComponent(new URL(manage).pathname.slice('/u/'.length)))).toEqual({
      userId: 'user_1',
      group: 'all',
    });

    // The token in the footer belongs to the recipient and to nobody else — the
    // failure mode the whole call-site audit was about is silent, because the
    // mail still arrives, just with somebody else's token in it.
    const other = hrefs(unsubscribeFooterHtml('user_2', 'digests'))[0];
    expect(other).not.toBe(unsub);
  });

  test('names the group in the reader’s own language when a locale is given', () => {
    const en = unsubscribeFooterHtml('user_1', 'digests', 'en');
    const tr = unsubscribeFooterHtml('user_1', 'digests', 'tr');
    const de = unsubscribeFooterHtml('user_1', 'digests', 'de');
    expect(en).toContain('Roll-up summaries');
    expect(tr).toContain('Toplu özetler');
    expect(de).toContain('Sammelübersichten');
    // An unknown or missing locale falls back rather than rendering `undefined`.
    expect(unsubscribeFooterHtml('user_1', 'digests', 'kl')).toContain('Roll-up summaries');
    expect(unsubscribeFooterHtml('user_1', 'digests', null)).toContain('Roll-up summaries');
  });

  test('is ONE line, so htmlToText keeps the URL in the text/plain part', () => {
    // htmlToText's anchor regex has no `s` flag: an <a> broken across lines
    // matches nothing, the generic tag-strip eats it, and the visible opt-out
    // disappears from the plain-text half of the message. Gmail wants it in
    // both parts, so this is not cosmetic.
    const footer = unsubscribeFooterHtml('user_1', 'announcements');
    expect(footer).not.toContain('\n');

    const text = htmlToText(withUnsubscribeFooter('<div><p>Hello</p></div>', footer));
    const unsub = hrefs(footer)[0];
    expect(text).toContain(unsub);
    expect(text).toContain(hrefs(footer)[1]);
  });

  test('is injected exactly once, even when the same body is passed through twice', () => {
    const footer = unsubscribeFooterHtml('user_1', 'digests');
    const once = withUnsubscribeFooter('<div style="max-width:600px"><p>Body</p></div>', footer);
    const twice = withUnsubscribeFooter(once, footer);

    expect(twice).toBe(once);
    const count = (s: string) => s.split(UNSUB_FOOTER_MARKER).length - 1;
    expect(count(once)).toBe(1);
    expect(count(twice)).toBe(1);
    // A second, DIFFERENT footer must not slip past the marker either — that
    // would be two opt-out blocks, one of them for the wrong group.
    expect(count(withUnsubscribeFooter(once, unsubscribeFooterHtml('user_1', 'announcements')))).toBe(1);
  });

  test('lands inside the template’s own 600px wrapper, not full-bleed under it', () => {
    const footer = unsubscribeFooterHtml('user_1', 'digests');
    const wrapped = withUnsubscribeFooter('<div style="max-width:600px"><p>Body</p></div>', footer);
    expect(wrapped.endsWith('</div>')).toBe(true);
    expect(wrapped.indexOf(UNSUB_FOOTER_MARKER)).toBeGreaterThan(wrapped.indexOf('<p>Body</p>'));
    // …and a body that does not end in a div still gets it, appended.
    const bare = withUnsubscribeFooter('<h2>Announcement</h2><p>Body</p>', footer);
    expect(bare.startsWith('<h2>Announcement</h2>')).toBe(true);
    expect(bare).toContain(UNSUB_FOOTER_MARKER);
  });

  test('defuses an inherited white-space:pre-wrap', () => {
    // src/lib/outcomeComms.server.ts renders its body inside a pre-wrap div and
    // the footer is injected *inside* that wrapper, so without this the footer
    // would render with the markup's own whitespace as blank lines.
    expect(unsubscribeFooterHtml('user_1', 'pipeline_updates')).toContain('white-space:normal');
  });
});

test.describe('the List-* headers', () => {
  test('a non-essential group gets RFC 8058 one-click, POST-only', () => {
    const h = unsubscribeHeaders('user_1', 'digests');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const advertised = h['List-Unsubscribe'];
    expect(advertised.startsWith('<')).toBe(true);
    const one = advertised.slice(1, advertised.indexOf('>'));
    expect(one).toContain('/api/unsubscribe/one-click?t=');
    // The URI in the header addresses the same person and group as the footer.
    expect(verifyUnsubscribeToken(new URL(one).searchParams.get('t') ?? '')).toEqual({
      userId: 'user_1',
      group: 'digests',
    });
  });

  test('only automated volume is marked as a list', () => {
    // Bulk: a digest is a list, and `Precedence: bulk` keeps a reminder blast
    // from spending the reputation of the domain that carries sign-in mail.
    const bulk = unsubscribeHeaders('user_1', 'digests');
    expect(isBulkGroup('digests')).toBe(true);
    expect(bulk['List-Id']).toContain('digests.');
    expect(bulk['Precedence']).toBe('bulk');
    expect(bulk['Auto-Submitted']).toBe('auto-generated');
    expect(bulk['X-Auto-Response-Suppress']).toBe('OOF, AutoReply');

    // Not bulk: a 1:1 notification is not a list, and these mails often expect a
    // reply through the `reply+` address that an auto-response suppression
    // header would interfere with. It still carries the one-click opt-out.
    const direct = unsubscribeHeaders('user_1', 'direct_messages');
    expect(isBulkGroup('direct_messages')).toBe(false);
    expect(direct['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(direct['List-Id']).toBeUndefined();
    expect(direct['Precedence']).toBeUndefined();
    expect(direct['Auto-Submitted']).toBeUndefined();
  });

  test('the mailto: form is advertised only when a mailbox is configured', () => {
    // inboundMailBridge + routeInboundEmail understand `reply+<token>@` and
    // nothing else, so an unsubscribe mailbox nobody processes would black-hole
    // a real opt-out — a compliance failure rather than a courtesy.
    const saved = process.env.UNSUBSCRIBE_MAILTO;
    try {
      delete process.env.UNSUBSCRIBE_MAILTO;
      expect(unsubscribeHeaders('user_1', 'digests')['List-Unsubscribe']).not.toContain('mailto:');

      process.env.UNSUBSCRIBE_MAILTO = 'unsubscribe@ersah.in';
      const h = unsubscribeHeaders('user_1', 'digests')['List-Unsubscribe'];
      expect(h).toContain('<mailto:unsubscribe@ersah.in?subject=unsubscribe>');
      // https FIRST: RFC 2369 ordering is preference order and RFC 8058
      // one-click keys off the https URI, so a browser-capable client must reach
      // it before the mailbox.
      expect(h.indexOf('https') === -1 ? h.indexOf('http') : h.indexOf('https')).toBeLessThan(h.indexOf('mailto:'));
    } finally {
      if (saved === undefined) delete process.env.UNSUBSCRIBE_MAILTO;
      else process.env.UNSUBSCRIBE_MAILTO = saved;
    }
  });
});

test.describe('the SMTP channel split', () => {
  // The exact set BULK_CATEGORIES was hand-maintained as before it became
  // derived from the groups. Every entry must still be on the bulk relay: a
  // regression here silently moves automated volume back onto the transport
  // that carries password resets, which is the reputation the split exists to
  // protect — and nothing else in the suite would notice.
  const PREVIOUSLY_HAND_CODED = [
    'unread-digest',
    'activity-digest',
    'mentor-digest',
    'analytics-report',
    'meeting-reminder',
    'interaction-reminder',
    'stage-deadline',
    'retention-reminder',
    'company-need-alert',
    'announcement',
    'document-reminder',
  ];

  test('keeps every category the hand-coded set carried', () => {
    for (const category of PREVIOUSLY_HAND_CODED) {
      expect(BULK_CATEGORIES.has(category), `${category} left the bulk relay`).toBe(true);
    }
  });

  test('the essential-but-bulk exception is exactly one category, and documented', () => {
    // 'retention-reminder' is the one category whose transport and consent
    // answers disagree: it rides the bulk relay (dated blast) but belongs to an
    // essential group (a legally required notice, never unsubscribable). It
    // therefore cannot be derived from the bulk groups and is unioned in.
    expect([...LEGACY_BULK_CHANNEL]).toEqual(['retention-reminder']);
    expect(groupForCategory('retention-reminder')).toBe('account_security');

    const derived = new Set(EMAIL_GROUPS.filter((g) => g.bulk).flatMap((g) => g.categories));
    for (const category of BULK_CATEGORIES) {
      expect(derived.has(category) || LEGACY_BULK_CHANNEL.has(category), `${category} rides bulk for no stated reason`).toBe(true);
    }
  });

  test('sign-in and 1:1 mail never rides the bulk relay', () => {
    for (const category of ['verification', 'password-reset', 'invitation', 'account', 'message', 'mentor-direct', 'meeting-invite', 'offer']) {
      expect(BULK_CATEGORIES.has(category), category).toBe(false);
    }
  });
});

test.describe('the taxonomy covers what the app actually sends', () => {
  // A category with no group gets no group id, hence no footer, no List-*
  // headers and no gating — silently, because the mail still goes out and looks
  // fine. That is the exact failure this feature exists to prevent, and a typo
  // in a new `category:` string is all it takes, so the source is the oracle.
  const SRC = path.join(process.cwd(), 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  test('every category literal at a send site belongs to a group', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      // Only files that actually send mail. `category:` is also a cookie-consent
      // and a feature-catalogue field name, and those have nothing to do with
      // this taxonomy.
      if (!src.includes('sendEmail(') && !src.includes('emailService')) continue;
      for (const m of src.matchAll(/\bcategory:\s*'([a-z0-9-]+)'/g)) {
        seen++;
        if (!groupForCategory(m[1])) offenders.push(`${path.relative(process.cwd(), file)}: ${m[1]}`);
      }
    }
    // If this drops to zero the regex stopped matching and the test is vacuous.
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  // The bug this test exists for (#1456): ten send sites `&&`-ed a legacy
  // `emailAllowed(user, '<key>')` check whose key mapped to a DIFFERENT group
  // than the mail behind it — `meetingReminders` (group meeting_reminders) in
  // front of a meeting *invitation*, `digest` in front of the analytics report,
  // `messages` in front of an enquiry from a public profile. Both preference
  // surfaces render resolveEmailGroupPrefs(), which only knows the group→legacy
  // mapping, so they showed "Meeting invites: ON" while every invite was
  // dropped. Nothing failed: the mail simply never arrived.
  //
  // So the property, over the whole taxonomy rather than site by site: for a
  // user whose ONLY recorded preference is one legacy key switched off, what a
  // send site actually does must equal what the surfaces say it does. Asserted
  // against the real guards in the real source, because the mismatch cannot
  // exist anywhere else — emailGroupAllowedForCategory() and
  // resolveEmailGroupPrefs() both go through emailGroupAllowed(), so a test
  // written purely against the library would agree with itself and prove
  // nothing.
  test('every legacy key a send-site guard depends on is what the surfaces show', () => {
    // Comments are stripped first: several of the fixed call sites now *quote*
    // the old broken guard in prose to explain why it went, and a scan that
    // reads prose would report the very bug the prose is describing.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    // sendXEmail() → the category it sends, for the guards that name no category
    // themselves (the guard sits at the call site, the `category:` literal lives
    // in the sender).
    const senderCategory = new Map<string, string>();
    const service = strip(fs.readFileSync(path.join(SRC, 'services', 'emailService.ts'), 'utf8'));
    for (const [, name, body] of service.matchAll(/export async function (send\w+)\(([\s\S]*?)(?=\nexport |$)/g)) {
      const cat = body.match(/\bcategory:\s*'([a-z0-9-]+)'/);
      if (cat) senderCategory.set(name, cat[1]);
    }
    expect(senderCategory.size).toBeGreaterThan(10);

    const GUARD = /\bemailAllowed\(\s*([\w$.?]+)\s*,\s*'(\w+)'\s*\)/g;
    const pairs: { where: string; key: NotificationCategory; category: string }[] = [];
    const unpaired: string[] = [];

    for (const file of walk(SRC)) {
      const src = strip(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(process.cwd(), file);
      const guards = [...src.matchAll(GUARD)];
      for (const [i, g] of guards.entries()) {
        const from = g.index! + g[0].length;
        // The window ends at the next guard, so a site can never borrow the
        // category of the one below it (the mentor/mentee pairs sit two lines
        // apart), and at 1500 chars otherwise.
        const to = Math.min(guards[i + 1]?.index ?? src.length, from + 1500);
        const after = src.slice(from, to);
        const candidates = [
          after.match(/emailGroupAllowedForCategory\([^)]*'([a-z0-9-]+)'\s*\)/),
          after.match(/\bcategory:\s*'([a-z0-9-]+)'/),
          after.match(/\b(send\w*Email)\(/),
        ].filter((m): m is RegExpMatchArray => !!m).sort((a, b) => a.index! - b.index!);
        const first = candidates[0];
        const category = !first ? null : senderCategory.get(first[1]) ?? first[1];
        const where = `${rel}: emailAllowed(…, '${g[2]}')`;
        // An unpaired guard is not a pass — it is a site this test cannot see,
        // which is exactly how the original ten hid.
        if (!category || !groupForCategory(category)) unpaired.push(`${where} → ${category ?? 'no category found'}`);
        else pairs.push({ where, key: g[2] as NotificationCategory, category });
      }
    }

    expect(unpaired).toEqual([]);
    // Teeth: if the regexes stop matching, everything below passes vacuously.
    expect(pairs.length).toBeGreaterThan(12);

    const lies: string[] = [];
    for (const { where, key, category } of pairs) {
      // A key the regex captured that is not a real category would make
      // emailAllowed() default to ON and the whole guard a no-op.
      expect(NOTIFICATION_CATEGORIES as readonly string[], where).toContain(key);

      const user = { notificationPrefs: { [key]: false } };
      const group = groupForCategory(category)!;
      // What the site does, spelled out the way the site spells it…
      const sends = emailAllowed(user, key) && emailGroupAllowedForCategory(user, category);
      // …against what /account and /u/<token> both render for that group.
      const shown = resolveEmailGroupPrefs(user)[group];
      if (shown !== sends) {
        lies.push(
          `${where} guards ${category} (${group}): surfaces show ${shown ? 'ON' : 'OFF'}, ` +
            `the site ${sends ? 'sends' : 'drops'} it — add '${key}' to ${group}.legacy or drop the conjunct`
        );
      }
    }
    expect(lies).toEqual([]);

    // And the mapping is only honest if the key really is in that group's
    // `legacy` array — the same fact from the other side, so a future
    // resolveEmailGroupPrefs() that stopped consulting `legacy` at all (making
    // both sides agree on ON while the guard still drops the mail) cannot pass.
    for (const { where, key, category } of pairs) {
      expect(emailGroupDef(groupForCategory(category)!).legacy as readonly string[], where).toContain(key);
    }
  });

  test('every group is reachable from at least one category the app sends', () => {
    const used = new Set<string>();
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('sendEmail(') && !src.includes('emailService')) continue;
      for (const m of src.matchAll(/\bcategory:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    }
    const reachable = new Set<EmailGroupId>();
    for (const category of used) {
      const g = groupForCategory(category);
      if (g) reachable.add(g);
    }
    // A group with no live category is a switch that cannot silence anything —
    // it would sit in the preference centre promising something it cannot do.
    for (const g of EMAIL_GROUPS) {
      expect(reachable.has(g.id), `${g.id} has no category any send site uses`).toBe(true);
    }
  });
});
