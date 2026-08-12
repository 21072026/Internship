export function companyInterestScopeKey(companyId: string, menteeId: string, requisitionId?: string | null) {
  return requisitionId
    ? `requisition:${requisitionId}:${menteeId}`
    : `legacy:${companyId}:${menteeId}`;
}
