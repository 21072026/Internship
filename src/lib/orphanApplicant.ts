import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { APPLY_NO_LOGIN_PASSWORD, ERASED_EMAIL_DOMAIN } from '@/lib/menteeAccount';

// "Orphan applicant" — the one place the rule is written (#1780).
//
// The public application link (`POST /api/apply`) creates a real `User` row
// BEFORE any human has said yes: the applicant needs an account to set a
// password on, and the mentor decides afterwards through the
// `MentorshipRequest` the same request files (#1188). When the mentor declines,
// nothing at all happens to that account. It cannot sign in (its password is a
// sentinel, never a bcrypt hash), nobody owns it, no relation points at it —
// and it stays in the user table forever, counting towards every candidate
// number and holding a name, an e-mail address, a phone number and a university
// with no purpose left to serve. That is a storage-limitation failure (GDPR
// Art. 5(1)(e) / KVKK m.4), not untidiness: `src/lib/retention.ts` anchors
// retention on `consentAt`, and an apply-link account never has one, so the
// existing review queue can never surface it.
//
// This module owns the definition and nothing else. Every caller — the admin
// list, the badge on the candidate card, the nightly sweep — asks THIS file
// what an orphan is, the way `src/lib/dormantFirstContact.ts` owns dormancy.
// A definition guessed at per call site is how "we deleted the wrong account"
// happens.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// An account is an orphan applicant when ALL of the following hold:
//
//   1. it is a MENTEE whose password is still the apply-link sentinel — so it
//      was minted by /apply and has never been activated;
//   2. its e-mail was never verified and it has never logged in;
//   3. it has NO mentorship relation, in either direction;
//   4. every mentorship request it ever filed is REJECTED (or it filed none);
//   5. it shows no other sign of life at all (see below);
//   6. it is not already erased;
//   7. and — for the SWEEP only — no activation link is outstanding on it.
//
// ── Why the rule is conservative, and deliberately narrower than it could be ─
//
// The clean-up this feeds is automatic and irreversible, so every ambiguous
// case is resolved by NOT touching the account. Two choices follow from that:
//
// * Only the apply-link sentinel counts. #1780 sketched the rule over "any
//   no-login sentinel", which would also sweep up `'!created-no-login'` rows —
//   mentees a mentor typed in by hand. Those are somebody's working notes on a
//   real person they are still chasing, they carry no rejected request to prove
//   the answer was no, and nobody asked for them to be deleted. They are left
//   alone. Widening the rule later is one line (`ORPHAN_SENTINEL_PASSWORDS`);
//   un-deleting an account is not.
// * Any sign of life excludes the account, and "sign of life" is read
//   generously: a consent record, an admin's tag, an uploaded CV, a document, a
//   support ticket, a company's interest, an interview request, a project
//   membership, a conversation somebody started, a started onboarding. None of
//   those can be produced by an account that cannot sign in — which is exactly
//   why any one of them means a human intervened, and a human's work is not
//   swept away on a timer.
//
// Messages are NOT in the list, and cannot be: `Message.senderId` has no
// foreign key to `User` (see the header of `src/lib/accountErasure.ts`), so
// there is no relation to filter on — and an account with no password cannot
// sign in to write one either way.
//
// ── The rescue, and why it is part of the rule ──────────────────────────────
//
// The dry run's whole promise is that an admin who spots a wrong decision can
// stop the sweep — and the only button that does that non-destructively is
// "send set-password link". That mints a `PasswordResetToken` and mails it;
// nothing on the `User` row changes, so without clause 7 the sweep would take
// the account that same night AND `anonymizeUser` would delete the very token
// it had just mailed (src/lib/accountErasure.ts). The applicant would click a
// dead link into an erased account, which is precisely the outcome the panel
// exists to prevent.
//
// So an OUTSTANDING link — unused and unexpired — postpones the sweep for as
// long as it is live (7 days for a SET_INITIAL link). It postpones rather than
// cancels on purpose: a link nobody acts on must not keep an abandoned account
// alive forever, and re-sending it is one click. The account stays on the list
// throughout, flagged, so the admin can see the reprieve rather than infer it,
// and `daysUntilAnonymize` counts down to whichever of the two gates clears
// last — a countdown that ignored the hold would print a date that is not when
// anything happens.
//
// Note that `/apply` itself issues a 7-day SET_INITIAL link to every account it
// mints, so a fresh applicant is held for its first week. That costs nothing:
// the grace period is 90 days, and the link is a fortnight dead by the time the
// age gate opens. The hold only ever decides the answer when a human sent a new
// one — which is exactly the case it exists for.
//
// The exclusion is on the SWEEP's branch only — the listing still shows the
// account, because the page's job is to show everything the rule holds, with
// its state, not only what is due tonight.
//
// ── The clock ───────────────────────────────────────────────────────────────
//
// Age is measured from BOTH the account's creation and the decision on its
// request: an account created a year ago whose application was declined
// yesterday is one day old as far as this rule is concerned. Measuring from
// creation alone would let the sweep erase an account the same week a mentor
// looked at it.

/**
 * The password sentinels an orphan applicant may carry.
 *
 * One entry today, on purpose — see the header. It is a list rather than a
 * comparison so that widening the rule is a reviewed one-line change in this
 * file instead of a new predicate somewhere else.
 */
export const ORPHAN_SENTINEL_PASSWORDS: readonly string[] = [APPLY_NO_LOGIN_PASSWORD];

/**
 * Default grace period before the nightly sweep anonymizes an orphan, in days.
 *
 * Ninety days, and the number is a fallback rather than the rule: the live
 * value is the `orphanApplicantGraceDays` setting. Three months is long enough
 * that a mentor who declined in error, or an applicant who reapplies through a
 * different mentor's link, is still recoverable by a human — and short enough
 * that a declined application is not a permanent record of somebody who was
 * told no. It is deliberately longer than the 30-day grace the consent-based
 * retention review uses, because nobody is ever *reminded* about an orphan the
 * way a candidate is asked to re-consent: the only warning is the admin list.
 */
export const ORPHAN_APPLICANT_GRACE_DAYS = 90;

/** The `Setting` key holding the live grace period. */
export const ORPHAN_GRACE_SETTING_KEY = 'orphanApplicantGraceDays';

/**
 * Rows one nightly run may anonymize.
 *
 * Two orders of magnitude below the retention registry's own 50 000 budget, and
 * deliberately so: every other entry issues one `deleteMany` per 500 ids, while
 * this one runs `anonymizeUser` — a dozen statements in a transaction, plus a
 * device revocation — once PER ACCOUNT. A first run against a backlog that has
 * accumulated since the apply link shipped would otherwise be a long write
 * storm at 03:20. Two hundred a night drains any realistic backlog inside a
 * fortnight, and the entry reports `capped: true` while it is still catching up.
 *
 * It lives here rather than next to the job because the admin dry run has to
 * say the same number: "800 are due" and "the next run takes 800" are not the
 * same sentence, and the second one is the one an admin acts on.
 */
export const ORPHAN_ANONYMIZE_PER_RUN = 200;

export interface OrphanApplicant {
  id: string;
  fullName: string;
  email: string;
  /** When the application came in. */
  createdAt: Date;
  /** When the request was declined, when a declined request exists. */
  declinedAt: Date | null;
  /**
   * Who actually decided it (`MentorshipRequest.decidedBy`), falling back to
   * the mentor the application named when the decider's account is gone.
   * `null` with a non-null `declinedAt` means "declined, decider unknown" —
   * which is a different statement from "no decision recorded", and the panel
   * renders it as one.
   */
  declinedBy: string | null;
  /**
   * An unused, unexpired password link is outstanding on this account, so the
   * sweep will not take it while that lasts (clause 7 — see the header).
   */
  activationPending: boolean;
  /** Whole days since the later of `createdAt` and `declinedAt`. */
  ageDays: number;
  /**
   * Whole days before the nightly sweep would anonymize this row: the LATER of
   * the grace period running out and any outstanding link expiring, because the
   * sweep needs both gates open. `0` means "the next run takes it".
   */
  daysUntilAnonymize: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rule, as a Prisma `where` fragment — the single source every caller uses.
 *
 * `agedBefore` adds the age gate: pass the sweep's cutoff to get exactly the
 * rows that would be anonymized now, or omit it to list every orphan whatever
 * its age (what the admin surface shows, so the dry run includes the ones due
 * next month).
 */
export function orphanApplicantWhere(agedBefore?: Date): Prisma.UserWhereInput {
  return {
    role: 'MENTEE',
    // Minted by /apply and never activated. Setting a password rewrites this
    // column to a bcrypt hash, so this one predicate already excludes everyone
    // who ever completed the flow.
    password: { in: [...ORPHAN_SENTINEL_PASSWORDS] },
    // Belt and braces on the same fact: `/api/auth/reset` marks the address
    // verified as it sets the initial password, and only a sign-in stamps
    // `lastLoginAt`.
    emailVerified: false,
    lastLoginAt: null,
    // A consent record means `src/lib/retention.ts` already governs this
    // person, and two retention rules over one row is how a record gets erased
    // by the one nobody was reading.
    consentAt: null,
    // Already anonymized — without this the sweep would re-erase the same rows
    // every night, because anonymizing does not change the password column.
    NOT: { email: { endsWith: `@${ERASED_EMAIL_DOMAIN}` } },
    // No mentorship in either direction. A MENTEE cannot normally hold a
    // mentor-side relation, and that is the point: if one exists, something
    // about this row is not what this rule assumes.
    menteeRelations: { none: {} },
    mentorRelations: { none: {} },
    // Every request they filed was declined (or they filed none). A PENDING
    // request is a decision still being made; an APPROVED one has a relation
    // behind it.
    mentorshipRequests: { none: { status: { not: 'REJECTED' } } },
    // Signs of life. Each one is a thing a human did to or for this account.
    consents: { none: {} },
    tags: { none: {} },
    cvFile: { is: null },
    cvUrl: null,
    avatarFile: { is: null },
    documents: { none: {} },
    supportTickets: { none: {} },
    companyInterests: { none: {} },
    interviewRequests: { none: {} },
    projectMemberships: { none: {} },
    conversationParticipants: { none: {} },
    menteeOnboarding: { none: {} },
    ...(agedBefore
      ? {
          createdAt: { lt: agedBefore },
          // …and nobody decided anything about them inside the window either.
          mentorshipRequests: {
            none: {
              OR: [{ status: { not: 'REJECTED' } }, { decidedAt: { gte: agedBefore } }],
            },
          },
          // Clause 7, sweep-only: an admin who sent a set-password link has
          // intervened, and the sweep would otherwise erase the account and
          // delete the link in the same transaction. See "The rescue" above.
          passwordResetTokens: { none: { used: false, expiresAt: { gt: new Date() } } },
        }
      : {}),
  };
}

/** How many orphan applicants there are (optionally, only the aged ones). */
export function countOrphanApplicants(agedBefore?: Date): Promise<number> {
  return prisma.user.count({ where: orphanApplicantWhere(agedBefore) });
}

/**
 * Which of the given user ids are orphan applicants.
 *
 * One extra query per rendered page rather than a per-row check: the candidate
 * list needs the badge on rows it has already fetched, and re-deriving the rule
 * client-side is precisely what this module exists to prevent.
 */
export async function markOrphanApplicants(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.user.findMany({
    where: { AND: [orphanApplicantWhere(), { id: { in: userIds } }] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * The list an admin sees BEFORE anything is deleted — the dry run.
 *
 * `graceDays` is only used to compute `daysUntilAnonymize`; the list itself is
 * every orphan regardless of age, because the point of the surface is to show
 * what is coming, not only what is already due.
 */
export async function listOrphanApplicants(options: {
  graceDays?: number;
  take?: number;
  now?: Date;
} = {}): Promise<OrphanApplicant[]> {
  const graceDays = options.graceDays ?? ORPHAN_APPLICANT_GRACE_DAYS;
  const now = options.now ?? new Date();

  const users = await prisma.user.findMany({
    where: orphanApplicantWhere(),
    select: {
      id: true,
      fullName: true,
      email: true,
      createdAt: true,
      mentorshipRequests: {
        where: { status: 'REJECTED' },
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: {
          decidedAt: true,
          // Who decided, not who was asked: `preferredMentor` is the mentor the
          // applicant picked and may never have touched the request (an admin
          // usually clears the queue). It is the fallback only, for when the
          // decider's own account has since been deleted — `decidedById` is
          // nulled by the erasure path, `preferredMentorId` by `SetNull`.
          decidedBy: { select: { fullName: true } },
          preferredMentor: { select: { fullName: true } },
        },
      },
      // Clause 7: the same predicate the sweep excludes on, read back so the
      // page can say WHY a row that looks due is not going anywhere tonight.
      passwordResetTokens: {
        where: { used: false, expiresAt: { gt: now } },
        orderBy: { expiresAt: 'desc' },
        select: { expiresAt: true },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
    ...(options.take ? { take: options.take } : {}),
  });

  return users.map((u) => {
    const decision = u.mentorshipRequests[0];
    const declinedAt = decision?.decidedAt ?? null;
    // The later of the two clocks — see "The clock" in the header.
    const anchor = declinedAt && declinedAt > u.createdAt ? declinedAt : u.createdAt;
    const ageDays = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / DAY_MS));
    // An outstanding link holds the sweep off until it expires; rounded UP, so
    // the countdown never promises the account is gone while the link still
    // works for part of that day.
    const liveLink = u.passwordResetTokens[0]?.expiresAt ?? null;
    const linkDays = liveLink
      ? Math.max(0, Math.ceil((liveLink.getTime() - now.getTime()) / DAY_MS))
      : 0;
    return {
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      createdAt: u.createdAt,
      declinedAt,
      declinedBy: decision?.decidedBy?.fullName ?? decision?.preferredMentor?.fullName ?? null,
      activationPending: liveLink !== null,
      ageDays,
      // Both gates, not just the age one — see "The rescue" in the header.
      daysUntilAnonymize: Math.max(0, graceDays - ageDays, linkDays),
    };
  });
}
