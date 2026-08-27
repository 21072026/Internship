import { NextResponse } from 'next/server';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { makeUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/unsubscribeToken';
import { applyGroupPref } from '../applyUnsubscribe';

// RFC 8058 one-click unsubscribe — the endpoint advertised in the
// `List-Unsubscribe` / `List-Unsubscribe-Post` headers (#1444).
//
// Gmail, Apple Mail and Outlook render their own "Unsubscribe" button next to
// the sender and POST this URL when it is pressed. There is no session, no
// cookie and no user agent we could challenge: the signed token is the whole
// credential, exactly as in ../route.ts (see the long note there for why that is
// both safe and bounded — the mail only ever reaches that user's own registered
// address, and the token can change nothing but that user's notification
// preferences).
//
// Never a session check here, and never one added later: an authenticated
// one-click unsubscribe is a contradiction in terms.

function text(body: string, status: number) {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function POST(request: Request) {
  // DELIBERATELY NOT RATE LIMITED. A 429 on this path is a compliance failure,
  // not a defence: the mail provider is acting on a person's behalf and will
  // report a failed one-click as a broken unsubscribe. There is nothing to
  // protect either — the token is unguessable, the only reachable effect is one
  // user's own preferences, and replaying the same request is idempotent.
  const t = new URL(request.url).searchParams.get('t') || '';
  const scope = verifyUnsubscribeToken(t);
  // Plain text, no JSON: the caller here is a mail client, and RFC 8058 asks for
  // a human-readable body. A forged or truncated token is a clean 400, never a
  // 500 and never a stack trace.
  if (!scope) return text('This unsubscribe link is not valid.', 400);

  // RFC 8058 specifies the body `List-Unsubscribe=One-Click`, and we accept it —
  // but the body is NEVER inspected to decide whether to act. Clients in the
  // wild send an empty body, a different charset, or a duplicated parameter, and
  // refusing any of those would mean refusing a real person's opt-out over a
  // formatting detail. The presence of the POST is the instruction.

  // A preference-centre token ('all') arriving here means a mail client acted on
  // the "manage preferences" URI, and the only thing a client can be asking for
  // is "stop" — so it switches every non-essential group off. (The /u page
  // treats the same token as "show me the switches", because there a human is
  // reading and can choose.)
  let state;
  try {
    state = await applyGroupPref(scope.userId, scope.group, false);
  } catch (e) {
    // A real infrastructure failure is the one case that must not answer 200:
    // a 5xx makes the provider retry, whereas a cheerful "Unsubscribed" would
    // strand the request forever.
    logger.error('One-click unsubscribe failed', { error: String(e) });
    return text('Could not apply the unsubscribe. Please try again.', 500);
  }

  // A deleted account is still a success. "Already gone" is exactly the state
  // the caller asked for, and 200 twice for the same click is the whole point of
  // an idempotent endpoint.
  if (state) {
    await logActivity({
      action: 'email.unsubscribe',
      level: 'info',
      actorId: scope.userId,
      actorEmail: state.email,
      targetType: 'user',
      targetId: scope.userId,
      // Well under the 191-char ActivityLog.detail limit; the marker is what
      // distinguishes a provider's one-click from a click on the page.
      detail: `${scope.group} · one-click (RFC 8058)`,
      request,
    });
  }

  // 200 text/plain, no confirmation step, no redirect. Never a 3xx: POST
  // redirects are followed inconsistently and a provider that does not follow
  // it records the unsubscribe as failed. Never 401/403 either — there is no
  // identity to challenge.
  return text('Unsubscribed', 200);
}

/**
 * GET on the same URL is INERT on purpose.
 *
 * Every link scanner, antivirus gateway and Safe-Links rewriter fetches the URLs
 * in a message with a GET on arrival. If this method mutated, half our
 * recipients would be unsubscribed by their own employer's mail security before
 * they ever opened the mail. So a GET only forwards a human to the page, which
 * does the work from the browser — where a scanner, which runs no scripts, never
 * arrives.
 */
export async function GET(request: Request) {
  const t = new URL(request.url).searchParams.get('t') || '';
  const scope = verifyUnsubscribeToken(t);
  if (!scope) return text('This unsubscribe link is not valid.', 400);
  // The redirect target is re-minted from the VERIFIED scope rather than built
  // from the query string. Two reasons, and the second is why it is worth the
  // extra HMAC:
  //   • Nothing the caller sent reaches the redirect. `encodeURIComponent` on the
  //     raw token was already enough to keep it inside one path segment, but
  //     "user input cannot reach this sink at all" is a property a reader (and a
  //     static analyser — CodeQL flags the tainted form as an open redirect)
  //     can confirm locally, and the weaker version needs a paragraph of
  //     reasoning about what the encoder happens to escape.
  //   • A token that does not verify now gets a straight 400 instead of a
  //     pointless bounce to a page whose only job would be to say the same thing.
  // makeUnsubscribeToken is a pure HMAC over (userId, group) with no time
  // component, so this reproduces the caller's own token byte for byte — the
  // person still lands on exactly the URL the mail footer advertised.
  const canonical = makeUnsubscribeToken(scope.userId, scope.group);
  return redirectToPage(`/u/${encodeURIComponent(canonical)}`);
}

/**
 * The redirect target never touches `request.url`, in either leg.
 *
 * The path comes from a token we re-minted ourselves (above). The base comes from
 * the environment, or from nothing at all — and "nothing at all" is the
 * interesting case. Two separate problems ruled out the obvious
 * `new URL(path, request.url)`:
 *
 *   • Behind the Plesk nginx that terminates TLS, the request this handler sees
 *     is plain http:// on an internal port, so a base built from it can hand the
 *     browser a cleartext hop carrying a never-expiring unsubscribe token in the
 *     path.
 *   • `request.url`'s host is reconstructed from a header the caller sends, so it
 *     is remote input reaching a redirect sink — an open redirect, and CodeQL is
 *     right to say so. Fixing only the path leg left this one, which is why the
 *     first attempt at this did not clear the alert.
 *
 * With NEXT_PUBLIC_APP_URL unset we therefore emit a RELATIVE Location rather
 * than guessing a host. RFC 7231 §7.1.2 allows it, and the browser resolves it
 * against the URL it actually requested — which, for a person clicking through
 * from their mail client, is the public https one. So the fallback keeps the
 * visitor exactly where they already are instead of us echoing a host back at
 * them, which is both safer and closer to what we meant.
 */
function redirectToPage(path: string): NextResponse {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    try {
      // Parsed rather than concatenated: a stray trailing path or a typo in the
      // variable must not turn a redirect into a 500 on the opt-out path.
      return NextResponse.redirect(new URL(path, new URL(configured).origin), 302);
    } catch {
      // fall through to the relative form
    }
  }
  return new NextResponse(null, { status: 302, headers: { Location: path } });
}
