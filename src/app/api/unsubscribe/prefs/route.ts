import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { EMAIL_GROUP_IDS, isEssentialGroup, type EmailGroupId } from '@/lib/emailGroups';
import { verifyUnsubscribeToken } from '@/lib/unsubscribeToken';
import { applyGroupPref, readGroupState, type UnsubResult } from '../applyUnsubscribe';

// The preference centre behind the /u/<token> page (#1290): read every group's
// state, then flip one switch at a time.
//
// No session, ever — the signed token is the credential, for the reasons spelled
// out at length in ../route.ts. This route adds nothing to what that token
// already proves: it reads and writes one user's own notification switches and
// tells the caller the address the mail went to, which is the address they are
// reading it in.
//
// Single-toggle instant save, not a form: there is no Save button on that page,
// because a person who came from a footer link to stop one kind of mail should
// not have to discover a second control to make it stick.

const RATE = { limit: 120, windowMs: 10 * 60 * 1000 };

// A tuple, so zod both validates and narrows to EmailGroupId — the twelve ids
// come from the taxonomy rather than being restated here, so a group added to
// EMAIL_GROUPS is accepted without a second edit.
const groupSchema = z.enum([...EMAIL_GROUP_IDS] as [EmailGroupId, ...EmailGroupId[]]);

const postSchema = z.object({
  token: z.string().min(1).max(512),
  group: groupSchema,
  enabled: z.boolean(),
});

function payload(scope: { group: EmailGroupId | 'all' }, state: UnsubResult) {
  return NextResponse.json({
    email: state.email,
    name: state.name,
    // The token's own scope, not the group just toggled: the page uses it to
    // decide whether it is a one-group unsubscribe confirmation or the plain
    // preference centre, and that does not change when a switch is flipped.
    group: scope.group,
    emailNotifications: state.emailNotifications,
    groups: state.groups,
  });
}

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, 'unsubscribe-prefs', RATE);
  if (limited) return limited;

  const scope = verifyUnsubscribeToken(new URL(request.url).searchParams.get('t') || '');
  if (!scope) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const state = await readGroupState(scope.userId);
  if (!state) return NextResponse.json({ error: 'gone', gone: true }, { status: 404 });
  return payload(scope, state);
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'unsubscribe-prefs', RATE);
  if (limited) return limited;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const scope = verifyUnsubscribeToken(parsed.data.token);
  if (!scope) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const { group, enabled } = parsed.data;

  // An essential group has no switch to flip — sign-in, security and legally
  // required mail is sent regardless of every preference, including the master
  // one. Rejecting loudly rather than writing a key that nothing reads: a switch
  // that silently does nothing is worse than a switch that is not there.
  if (isEssentialGroup(group)) {
    return NextResponse.json(
      { error: 'That kind of e-mail is always sent and cannot be switched off.' },
      { status: 400 }
    );
  }

  const state = await applyGroupPref(scope.userId, group, enabled);
  if (!state) return NextResponse.json({ error: 'gone', gone: true }, { status: 404 });

  await logActivity({
    action: enabled ? 'email.resubscribe' : 'email.unsubscribe',
    level: 'info',
    actorId: scope.userId,
    actorEmail: state.email,
    targetType: 'user',
    targetId: scope.userId,
    // Comfortably inside the 191-char ActivityLog.detail column.
    detail: `${group} · preference centre`,
    request,
  });

  return payload(scope, state);
}
