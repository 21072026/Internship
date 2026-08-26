import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { isEssentialGroup } from '@/lib/emailGroups';
import { prisma } from '@/lib/prisma';
import { isLocale, type Locale } from '@/i18n/config';
import { verifyUnsubscribeToken } from '@/lib/unsubscribeToken';
import { applyGroupPref, readGroupState } from './applyUnsubscribe';

// Unsubscribe from a mail footer (#1290).
//
// THE SIGNED TOKEN IS THE ONLY CREDENTIAL. There is deliberately no
// getServerSession and no requireUser anywhere in this directory, and there must
// never be one:
//
//   * It is safe. The link only ever reaches the person it is about, because the
//     only way to get one is to receive a mail we addressed to that user's own
//     registered address — the same trust argument src/lib/emailActionToken.ts
//     and the password-reset link already run on, and the signature means a
//     token cannot be guessed, edited or re-pointed at somebody else.
//   * It is bounded. The token can do exactly one thing: change that one user's
//     own notification preferences. Every change it can make is reversible from
//     the same page, and nothing it can reach is worth stealing — strictly less
//     power than the 90-day emailActionToken we already mint.
//   * It is necessary. Demanding a password before somebody may stop being
//     mailed is how you keep mailing people who wanted out, and "sign in to
//     unsubscribe" is the single most reliable way to earn a spam complaint
//     instead of an opt-out. Gmail's RFC 8058 client cannot sign in at all.
//
// POST, not GET, on purpose: mail clients and corporate link scanners fetch
// every URL in a message on arrival, so a mutating GET would unsubscribe people
// who never clicked. The footer links to the /u/<token> page, which makes this
// call from the browser.

const schema = z.object({
  token: z.string().min(1).max(512),
  action: z.enum(['unsubscribe', 'resubscribe']).optional(),
});

/**
 * The recipient's own UI language, for the /u page to render itself in.
 *
 * The footer link that leads here is written in the language we mail this person
 * in, but the page it opens is visited SIGNED OUT: there is no session and no
 * `locale` cookie on a phone that has never used the app, so the page would
 * otherwise fall back to English under a Turkish link. The server already knows
 * the answer, so it says it — rather than putting the locale in the URL, which
 * would make an already long link longer and one more thing to get wrong.
 *
 * A second, tiny primary-key read on purpose: `applyUnsubscribe`'s narrow
 * USER_SELECT is the list of columns an unsubscribe token is allowed to see, and
 * widening it is not this route's call to make. Nothing here fails if the read
 * does — the page falls back to the ambient locale.
 */
async function preferredLocale(userId: string): Promise<Locale | null> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLanguage: true },
    });
    const lang = u?.preferredLanguage ?? undefined;
    return isLocale(lang) ? lang : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  // Rate limited, and deliberately kept that way — unlike /one-click, which must
  // never answer 429 because a mail provider records that as a broken
  // unsubscribe. This endpoint is reached from a browser, and every accepted
  // request with an action writes an ActivityLog row, so an unbounded loop here
  // is a write amplifier. The page has its own sentence for a 429 ("try again in
  // a moment", honouring the Retry-After we send) instead of reporting it as an
  // invalid link: behind one corporate NAT the whole office shares this bucket,
  // and telling the Nth person their opt-out link is broken is how an opt-out
  // turns into a spam complaint.
  const limited = enforceRateLimit(request, 'unsubscribe', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const scope = verifyUnsubscribeToken(parsed.data.token);
  // A malformed, truncated or forged token is a plain 400 with a flat string —
  // never a 500. The page turns this into "this link is no longer valid"; a
  // stack trace would turn a mistyped URL into an error report and would tell a
  // prober which half of the token they got right.
  if (!scope) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const action = parsed.data.action ?? null;
  const resubscribe = action === 'resubscribe';

  // The preference-centre link ('all') with no explicit action switches nothing
  // off. It is the "manage your e-mail preferences" footer link, and somebody
  // who clicks that has asked to *see* the switches, not to lose all their mail.
  // An explicit action on the same token does act — a mail client posting it
  // means "stop", and the Undo path means "all of it back".
  //
  // An essential group cannot be applied at all. No footer ever mints such a
  // token, so this is belt-and-braces — but reporting `applied: true` for a
  // write that cannot happen would show somebody "you are unsubscribed" over
  // mail they will keep receiving, and that lie is worse than the dead link.
  const targeted = scope.group !== 'all' && !isEssentialGroup(scope.group);
  const applied = targeted || (scope.group === 'all' && action !== null);

  const state = applied
    ? await applyGroupPref(scope.userId, scope.group, resubscribe)
    : await readGroupState(scope.userId);

  // The account is gone, so there is nothing left to unsubscribe. 404 with a
  // machine-readable flag: the page has its own sentence for this, distinct from
  // "invalid link", because the link was genuine.
  if (!state) return NextResponse.json({ error: 'gone', gone: true }, { status: 404 });

  if (applied) {
    // ActivityLog.detail is a 191-char column in this schema and has been
    // truncated-by-surprise before; a group id (or the literal 'all') is a
    // couple of dozen characters at worst.
    await logActivity({
      action: resubscribe ? 'email.resubscribe' : 'email.unsubscribe',
      level: 'info',
      actorId: scope.userId,
      actorEmail: state.email,
      targetType: 'user',
      targetId: scope.userId,
      detail: scope.group,
      request,
    });
  }

  // Nothing here that the signed token did not already prove: the address it was
  // sent to, the name we greet that address by, that user's own switches, and
  // the language we already write to them in.
  return NextResponse.json({
    ok: true,
    group: scope.group,
    applied,
    action: applied ? (resubscribe ? 'resubscribe' : 'unsubscribe') : null,
    name: state.name,
    email: state.email,
    emailNotifications: state.emailNotifications,
    groups: state.groups,
    locale: await preferredLocale(scope.userId),
  });
}
