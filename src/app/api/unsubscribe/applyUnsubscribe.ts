import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  EMAIL_GROUPS,
  EMAIL_GROUP_IDS,
  emailGroupPrefKey,
  isEssentialGroup,
  resolveEmailGroupPrefs,
  type EmailGroupId,
} from '@/lib/emailGroups';

// The read-modify-write behind all three unsubscribe routes (#1444). Not a
// route file — App Router only treats route.ts/page.tsx specially, so a shared
// module can live next to them, which is where the three callers can actually
// find it.

export interface GroupState {
  id: EmailGroupId;
  enabled: boolean;
  essential: boolean;
}

export interface UnsubResult {
  email: string;
  name: string | null;
  emailNotifications: boolean;
  groups: GroupState[];
}

// Exactly the four columns the unsubscribe surface may know about. A token
// proves "you are the person this mail was addressed to" and nothing else, so
// the routes must not be able to leak a profile through a wide select.
const USER_SELECT = {
  email: true,
  fullName: true,
  emailNotifications: true,
  notificationPrefs: true,
} as const;

type PrefUserRow = {
  email: string;
  fullName: string | null;
  emailNotifications: boolean;
  notificationPrefs: unknown;
};

function toResult(u: PrefUserRow): UnsubResult {
  // resolveEmailGroupPrefs deliberately ignores the master switch, so the
  // twelve switches show the user's own per-group choices; `emailNotifications`
  // travels alongside them and the page renders it as a separate note.
  const resolved = resolveEmailGroupPrefs({ notificationPrefs: u.notificationPrefs });
  return {
    email: u.email,
    name: u.fullName ?? null,
    emailNotifications: u.emailNotifications !== false,
    groups: EMAIL_GROUPS.map((g) => ({
      id: g.id,
      enabled: resolved[g.id],
      essential: g.essential,
    })),
  };
}

/**
 * A JSON column can hold whatever a past writer put there — `null`, a string,
 * an array. Anything that is not a plain object means "nothing recorded", never
 * "opted out of everything", and it must not make the route throw: a 500 on a
 * corrupt blob would leave somebody unable to unsubscribe at all.
 */
function prefsObject(raw: unknown): Record<string, unknown> {
  // Null-prototype accumulator. Every key written below comes from PREF_KEY, so
  // none of them can be `__proto__` — but `obj[k] = v` on an ordinary object is
  // the assignment that triggers the prototype setter, and an object with no
  // prototype removes the question instead of answering it. The spread that
  // seeds it is already safe (spread defines own properties rather than
  // assigning through setters, and JSON.parse likewise makes `__proto__` an
  // ordinary own key), so this guards the write, not the read.
  const out: Record<string, unknown> = Object.create(null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(out, raw as Record<string, unknown>);
  }
  return out;
}

/**
 * groupId -> the JSON key it is stored under, resolved once at module load.
 *
 * The write below indexes THIS table rather than calling emailGroupPrefKey() on
 * a value that arrived in a request. Both callers already constrain the group to
 * the taxonomy — `z.enum([...EMAIL_GROUP_IDS])` in the prefs route, and an
 * `isEmailGroupId` check inside verifyUnsubscribeToken for the signed one — so
 * nothing hostile could reach the old form either. CodeQL flagged it anyway
 * (remote property injection), and it was right to: "a validator upstream
 * narrowed this" is a claim a reader has to go and check, while "the property
 * name is read out of a frozen table built from a constant" is visible at the
 * write itself. Same reason the one-click redirect stopped deriving its target
 * from the request: prefer the version that needs no argument.
 */
const PREF_KEY: Readonly<Record<EmailGroupId, string>> = Object.freeze(
  Object.fromEntries(EMAIL_GROUP_IDS.map((id) => [id, emailGroupPrefKey(id)])) as Record<EmailGroupId, string>
);

/** null when the user no longer exists. */
export async function readGroupState(userId: string): Promise<UnsubResult | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  if (!user) return null;
  return toResult(user);
}

/**
 * Apply one preference change and return the full resulting state.
 *
 * MERGES into the existing notificationPrefs JSON, never replaces it. The same
 * blob carries the eleven legacy in-app keys, and `PUT /api/profile`'s
 * replace-the-whole-column semantics must not be copied here: an unsubscribe
 * that silently resurrected somebody's in-app opt-outs would be a data-loss bug
 * nobody would notice for months.
 *
 * `group === 'all'` writes every NON-essential group (that is what a
 * preference-centre token means when a mail client acts on it: "stop").
 * An essential group is silently ignored rather than rejected — there is no key
 * to write, and the routes reject it earlier, where a message can be shown.
 */
export async function applyGroupPref(
  userId: string,
  group: EmailGroupId | 'all',
  enabled: boolean
): Promise<UnsubResult | null> {
  // Interactive transaction so the read and the write cannot interleave with
  // another writer: Gmail's one-click POST and the browser's own POST race on
  // the same message routinely, and a lost update here would be an unsubscribe
  // the user watched succeed and that never took effect. For a single group both
  // racers write the same value, so the outcome is idempotent either way.
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
    if (!user) return null;

    const targets: EmailGroupId[] =
      group === 'all'
        ? EMAIL_GROUPS.filter((g) => !g.essential).map((g) => g.id)
        : isEssentialGroup(group)
          ? []
          : [group];

    if (targets.length === 0) return toResult(user);

    const prefs = prefsObject(user.notificationPrefs);
    for (const id of targets) prefs[PREF_KEY[id]] = enabled;

    const updated = await tx.user.update({
      where: { id: userId },
      // Back to an ordinary object for the driver. Safe by construction now:
      // every key is either one PREF_KEY supplied or one that was already stored.
      data: { notificationPrefs: { ...prefs } as Prisma.InputJsonValue },
      select: USER_SELECT,
    });
    return toResult(updated);
  });
}
