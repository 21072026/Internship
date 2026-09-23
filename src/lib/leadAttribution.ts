// Lead attribution — "which source actually brings customers?" (#2421).
//
// This is the source half of the marketing funnel's attribution question, and
// it is deliberately built on the models that already exist: `Source` (a
// school, an agency, a partner, a channel) plus the merged referrer pointer in
// src/lib/referrer.ts. There is NO `Campaign` model and this slice does not add
// one — a campaign is a `Source` row with a campaign's name, and the report
// below already carries the explicit "no source at all" bucket that the
// campaign report was wanted for.
//
// The arithmetic lives here, pure and unit-tested
// (scripts/test/lead-attribution.test.mjs), so the two routes that report
// attribution cannot drift apart:
//   • /api/admin/analytics/sources — the attribution table on /admin/analytics
//   • /api/admin/sources           — the per-source card on /admin/sources
//
// ── WHO COUNTS AS AN ATTRIBUTED PERSON ───────────────────────────────────────
//
// The routes used to ask for `role: 'MENTEE'` inline, which reads as "this
// report is about interns". It is not: it is about whoever the tenant's funnel
// is about. Two separate rules were tangled in that one literal, and they are
// pulled apart here.
//
//   1. The funnel's lead side. The `Role` enum is FROZEN
//      (ADMIN|MENTOR|MENTEE|COMPANY|SOURCE — see the SUPER_ADMIN note in
//      schema.prisma for why widening it is the expensive move), and the
//      data-model decision for the MARKETING vertical puts the lead person on
//      exactly the row a mentee sits on: the `menteeId` side of a
//      `MentorshipRelation`. The ROW TYPE is therefore identical in both
//      verticals and only the WORD changes — an i18n problem, solved by the
//      terminology overlay (src/i18n/verticalOverlays.ts), not a query problem.
//      Saying that once, here, with its reason, is the point: the next reader
//      of the route no longer has to guess whether the literal was a domain
//      rule or an oversight.
//
//   2. A `sourceId` that is not a referral. On a SOURCE login, `sourceId`
//      records *which source that account speaks for* — not who referred them
//      (src/lib/referrer.ts spells this out, and `encodeReferrer` already
//      honours it). Counting one would show a source as having referred itself,
//      and on the `sourcing` module's own screen that is the NORMAL case: a
//      partner institution with a login has exactly such a row pointing at it.
//
//      Rule 1 already excludes those accounts today, because the lead role is
//      not SOURCE. So this is not a second filter bolted onto the query — it is
//      the reason the population may never be widened without re-checking, and
//      `attributedLeadRoles()` below is where that check lives: it filters the
//      role list through `sourceIsReferral`, so the day a role is added here,
//      one whose `sourceId` is not a referral is dropped rather than counted.
//
// Widening the population to "everyone except SOURCE" was considered and
// rejected: it would count admins and reps as unattributed leads in the
// `unsourced` bucket, which is the one number on this report whose whole job is
// to be honest about what is untracked.
//
// ── ONE POPULATION, NUMERATOR AND DENOMINATOR ──────────────────────────────
//
// Every query behind a number on this report spreads `attributedLeadWhere()`:
// the per-source total, the per-source finished count and the `unsourced`
// bucket. They used to be spelled out one by one, and `GET /api/admin/sources`
// got it wrong — its numerator filtered on the role while its denominator was a
// bare `_count` of every User pointing at the source, so a source with a partner
// login and one won lead reported 50% conversion instead of 100%.

import type { Role } from '@prisma/client';
import { sourceIsReferral } from './referrer';

/**
 * The role the lead/candidate side of a funnel record carries — in EVERY
 * vertical, because the role enum is frozen and a marketing lead is the same
 * `menteeId` User an internship mentee is. See the header for why this is one
 * named constant rather than a per-vertical lookup.
 */
export const FUNNEL_LEAD_ROLE: Role = 'MENTEE';

/**
 * Every role this report may attribute to a source. One entry today; a list,
 * because that is what makes the SOURCE guard below reachable rather than
 * decorative.
 */
export const ATTRIBUTED_LEAD_ROLES: readonly Role[] = [FUNNEL_LEAD_ROLE];

/**
 * The roles actually counted: the list above, minus any role whose `sourceId`
 * is not a referral pointer (rule 2 in the header). Takes the list as an
 * argument so the rule can be exercised against a widened one.
 */
export function attributedLeadRoles(roles: readonly Role[] = ATTRIBUTED_LEAD_ROLES): Role[] {
  return roles.filter((r) => sourceIsReferral(r));
}

/**
 * The Prisma `where` fragment that defines the attributed population. Both
 * halves of every ratio on this report spread this one fragment — see the
 * header's last section for the bug that made that a rule.
 */
export function attributedLeadWhere(): { role: { in: Role[] } } {
  return { role: { in: attributedLeadRoles() } };
}

/** One attributed person: the stage key of every funnel record they lead. */
export interface AttributedLead {
  stages: string[];
}

/** One source and everyone attributed to it. */
export interface SourceIntake {
  id: string;
  name: string;
  leads: AttributedLead[];
}

/**
 * One row of the attribution table.
 *
 * The field names are the ones this report has shipped with since #539 and are
 * kept verbatim: a component, an XLSX export and a print report read them.
 * They are wire names and are shown to nobody — every visible label comes from
 * the dictionary and, for a MARKETING tenant, from the overlay on top of it.
 */
export interface SourceAttributionRow {
  id: string;
  name: string;
  /** People attributed to this source, whether or not they entered the funnel. */
  mentees: number;
  /** How many of them lead at least one funnel record. */
  inPipeline: number;
  /** How many of them reached one of the tenant's finished stages. */
  hired: number;
  /** Whole percent of `mentees` that finished. */
  conversionToHired: number;
}

/**
 * Per-source intake and conversion, in the order the sources were handed in.
 *
 * `finishedKeys` is the tenant's OWN finished-stage set — `outcomeStageKeys()`
 * resolves it from the org's `PipelineStage` rows. It is never a literal
 * `['HIRED_660','EMPLOYED_700']`: a tenant on its own stage catalogue (which is
 * every MARKETING tenant, whose preset ends at `DEAL_WON`) would otherwise read
 * 0% conversion from every source, for ever (#1882).
 *
 * A person counts as converted when ANY of their funnel records reached a
 * finished stage — one won deal is a won deal, even next to an open one.
 */
export function sourceAttributionRows(
  sources: SourceIntake[],
  finishedKeys: Iterable<string>,
): SourceAttributionRow[] {
  const finished = new Set(finishedKeys);
  return sources.map((s) => {
    const mentees = s.leads.length;
    const inPipeline = s.leads.filter((l) => l.stages.length > 0).length;
    const hired = s.leads.filter((l) => l.stages.some((k) => finished.has(k))).length;
    return {
      id: s.id,
      name: s.name,
      mentees,
      inPipeline,
      hired,
      conversionToHired: mentees ? Math.round((hired / mentees) * 100) : 0,
    };
  });
}
