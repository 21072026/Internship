// Client-safe shapes for the mentee job board (#1830) — the API's
// PORTAL_JOB_SELECT as the browser receives it.
export type PortalJob = {
  id: string;
  title: string;
  description: string | null;
  city: string | null;
  workMode: string | null;
  startDate: string | null;
  requiredSkills: unknown;
  openings: number;
  filled: number;
  company: { id: string; name: string; logoUrl: string | null; description?: string | null; slug?: string | null; isPublicProfile?: boolean };
};

/** A requisition's requiredSkills JSON as the list of strings it should be. */
export function skillsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}
