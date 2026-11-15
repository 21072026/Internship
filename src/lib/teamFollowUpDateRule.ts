// May this viewer see a COLLEAGUE's follow-up DAY on the sales calendar's Team
// view (#3778)? The user's decision of 2026-11-15: the team sees each other's
// work, so a rep who may read the org's sales book sees on which day a
// colleague's records are due a next step.
//
// Deliberately narrow, and deliberately NOT canSeeNextAction
// (src/lib/nextActionRule.ts), which stays exactly as it is and keeps gating the
// note and every other reader of the next-action columns. This rule allows ONE
// thing: the DATE, on ONE screen — GET /api/sales/calendar/team, whose loader
// (src/lib/salesCalendar.ts) never selects `nextActionNote`. It changes nothing
// in the team book's fields and nothing on the lead page.
//
// All three facts must hold: the viewer may read the org's book (the team-read
// rule — the org setting `salesTeamBookForReps` for a rep, always for an admin
// or the dispatcher), the viewer works on the sales surface, and the records
// are of the viewer's own org. Dependency-free so
// scripts/test/team-follow-up-date-rule.test.mjs loads it under plain Node.

export function canSeeTeamFollowUpDate(input: {
  /** salesTeamReadAllowed() for this viewer. */
  teamReadAllowed: boolean;
  /** hasSalesSurface(role, capabilities) for this viewer. */
  viewerHasSalesSurface: boolean;
  /** The records read are of the viewer's own org. */
  sameOrg: boolean;
}): boolean {
  return input.teamReadAllowed && input.viewerHasSalesSurface && input.sameOrg;
}
