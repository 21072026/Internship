/**
 * The skills-gap report (#1823) — the pure half.
 *
 * "What is my talent pool missing?" is a join and a subtraction once both
 * sides speak canonical skills: SUPPLY is who holds a skill (UserSkill, the
 * programme's visible mentees), DEMAND is which HIRING requisitions require it
 * (RequisitionSkill), weighted by the seats still open. `src/app/api/admin/
 * analytics/skills-gap/route.ts` loads the rows; everything it reports is
 * decided here, so the numbers are unit-tested without a database
 * (`scripts/test/skills-gap.test.mjs`).
 *
 * Definitions (the panel's footnotes say the same thing):
 *   - hiring        = status OPEN and filled < openings — the same rule as the
 *                     portal's job list and the match alerts. DRAFT, ON_HOLD,
 *                     FILLED, CANCELLED and a fully staffed OPEN one ask for
 *                     nobody, so they are not demand.
 *   - demandOpenings= the remaining seats of the hiring requisitions that
 *                     require the skill; demandRequisitions = how many of them.
 *   - holders       = distinct supply people holding it; avgLevel over those
 *                     who rated it (null when nobody did); confirmed = how
 *                     many of those levels a mentor confirmed.
 *   - gap           = demandOpenings − holders. Positive: under-supplied.
 *                     Seats and people are both headcounts, which is what
 *                     makes the subtraction mean something.
 *   - coverage      = hiring requisitions with at least one skill whose full
 *                     required set ONE supply person holds, over all hiring
 *                     requisitions with at least one skill. A requisition with
 *                     no canonical skills is reported separately, never
 *                     counted as covered.
 */

export interface Holding {
  userId: string;
  skillId: string;
  level: number | null;
  verified: boolean;
}

export interface RequisitionDemand {
  id: string;
  status: string;
  openings: number;
  filled: number;
  skillIds: readonly string[];
}

export interface SkillGapRow {
  skillId: string;
  holders: number;
  avgLevel: number | null;
  confirmed: number;
  demandRequisitions: number;
  demandOpenings: number;
  gap: number;
}

export interface SkillsGapReport {
  rows: SkillGapRow[];
  /** gap > 0, largest first. */
  underSupplied: SkillGapRow[];
  /** Held by the pool, required by no hiring requisition; most holders first. */
  unused: SkillGapRow[];
  coverage: { covered: number; total: number; share: number | null };
  hiringRequisitions: number;
  requisitionsWithoutSkills: number;
  supplyPeople: number;
}

export function isHiring(r: Pick<RequisitionDemand, 'status' | 'openings' | 'filled'>): boolean {
  return r.status === 'OPEN' && r.filled < r.openings;
}

export function buildSkillsGap(
  holdings: readonly Holding[],
  requisitions: readonly RequisitionDemand[],
  limit = 10,
): SkillsGapReport {
  const rows = new Map<string, SkillGapRow & { levelSum: number; rated: number; people: Set<string> }>();
  const row = (skillId: string) => {
    let r = rows.get(skillId);
    if (!r) {
      r = { skillId, holders: 0, avgLevel: null, confirmed: 0, demandRequisitions: 0, demandOpenings: 0, gap: 0, levelSum: 0, rated: 0, people: new Set() };
      rows.set(skillId, r);
    }
    return r;
  };

  const heldBy = new Map<string, Set<string>>();
  for (const h of holdings) {
    const r = row(h.skillId);
    if (r.people.has(h.userId)) continue;
    r.people.add(h.userId);
    if (h.level !== null) {
      r.levelSum += h.level;
      r.rated++;
      if (h.verified) r.confirmed++;
    }
    let set = heldBy.get(h.userId);
    if (!set) heldBy.set(h.userId, (set = new Set()));
    set.add(h.skillId);
  }

  const hiring = requisitions.filter(isHiring);
  let covered = 0;
  let total = 0;
  let withoutSkills = 0;
  for (const req of hiring) {
    const skills = [...new Set(req.skillIds)];
    if (skills.length === 0) {
      withoutSkills++;
      continue;
    }
    total++;
    const remaining = req.openings - req.filled;
    for (const s of skills) {
      const r = row(s);
      r.demandRequisitions++;
      r.demandOpenings += remaining;
    }
    for (const held of heldBy.values()) {
      if (skills.every((s) => held.has(s))) {
        covered++;
        break;
      }
    }
  }

  const out: SkillGapRow[] = [...rows.values()].map(({ levelSum, rated, people, ...r }) => ({
    ...r,
    holders: people.size,
    avgLevel: rated > 0 ? Math.round((levelSum / rated) * 10) / 10 : null,
    gap: r.demandOpenings - people.size,
  }));
  out.sort((a, b) => b.gap - a.gap || b.demandOpenings - a.demandOpenings || a.skillId.localeCompare(b.skillId));

  return {
    rows: out,
    underSupplied: out.filter((r) => r.gap > 0).slice(0, limit),
    unused: out
      .filter((r) => r.demandRequisitions === 0 && r.holders > 0)
      .sort((a, b) => b.holders - a.holders || a.skillId.localeCompare(b.skillId))
      .slice(0, limit),
    coverage: { covered, total, share: total > 0 ? Math.round((covered / total) * 1000) / 1000 : null },
    hiringRequisitions: hiring.length,
    requisitionsWithoutSkills: withoutSkills,
    supplyPeople: heldBy.size,
  };
}
