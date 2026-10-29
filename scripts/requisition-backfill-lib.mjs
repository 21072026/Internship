export function mapCompanyNeedToRequisition(need) {
  if (!need?.company?.orgId) throw new Error(`missing_org:${need?.id ?? 'unknown'}:${need?.companyId ?? 'unknown'}`);
  return {
    orgId: need.company.orgId, companyId: need.companyId, title: need.position,
    description: legacyDescription(need.period), status: 'OPEN', openings: need.count,
    filled: 0, requiredSkills: [], city: null, workMode: null, startDate: null,
    ownerId: null, closedAt: null, legacyCompanyNeedId: need.id,
  };
}

export function legacyDescription(period) {
  return `Legacy hiring period: ${period}`;
}

// Until #1875 the company PUT deleted every CompanyNeed of a company and
// recreated them on each save, so the SAME position came back under a new id
// after every edit. Keyed on the id alone, the converter would then mint a
// second OPEN requisition for a role it had already converted. A twin is a
// converted requisition of the same company, title and period whose source
// need no longer exists: the new need is that row again, so the twin ADOPTS
// it (its legacyCompanyNeedId is re-pointed) instead of a duplicate being
// created. Nothing is ever deleted; a twin whose source still exists is a
// genuinely separate need and is left alone. `claimed` holds requisition ids
// already adopted in this run, so one twin never absorbs two needs.
export function findAdoptableTwin(need, legacyRequisitions, liveNeedIds, claimed = new Set()) {
  const description = legacyDescription(need.period);
  return (
    legacyRequisitions.find(
      (r) =>
        r.companyId === need.companyId &&
        r.title === need.position &&
        r.description === description &&
        r.legacyCompanyNeedId &&
        !liveNeedIds.has(r.legacyCompanyNeedId) &&
        !claimed.has(r.id),
    ) ?? null
  );
}
