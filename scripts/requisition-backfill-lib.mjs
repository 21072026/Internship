export function mapCompanyNeedToRequisition(need) {
  if (!need?.company?.orgId) throw new Error(`missing_org:${need?.id ?? 'unknown'}:${need?.companyId ?? 'unknown'}`);
  return {
    orgId: need.company.orgId, companyId: need.companyId, title: need.position,
    description: `Legacy hiring period: ${need.period}`, status: 'OPEN', openings: need.count,
    filled: 0, requiredSkills: [], city: null, workMode: null, startDate: null,
    ownerId: null, closedAt: null, legacyCompanyNeedId: need.id,
  };
}
