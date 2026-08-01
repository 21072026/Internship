// Admin ↔ mentor "view mode" for admins who also mentor.
//
// An ADMIN is allowed into /mentor/* (see the mentor layout's role check), so
// switching modes is pure navigation — the mode is *derived from the URL*, never
// stored. That keeps the sidebar, the page and the address bar from disagreeing:
// there is no persisted flag that can go stale when a link (a notification, a
// bookmark) drops the admin straight into the other mode.

export type AppMode = 'admin' | 'mentor';

/** Sections that exist under both /admin and /mentor with the same slug. */
const SHARED_SECTIONS = [
  'board',
  'projects',
  'meetings',
  'calendar',
  'email',
  'mentee-activity',
  'analytics',
] as const;

/**
 * Sections whose counterpart lives under a different slug. Only the pairs where
 * the two pages really answer the same question are mapped; anything else falls
 * back to the mode's dashboard rather than guessing.
 */
const ALIASES: Record<AppMode, Record<string, string>> = {
  // Viewing candidates/mentorships as an admin → the mentees you personally mentor.
  admin: { candidates: 'mentees', mentorship: 'mentees' },
  // Your own mentees → the full candidate list.
  mentor: { mentees: 'candidates' },
};

/** The mode a pathname belongs to, or null for pages outside both shells. */
export function modeOf(pathname: string): AppMode | null {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/mentor' || pathname.startsWith('/mentor/')) return 'mentor';
  return null;
}

/**
 * Where the mode switch should land, keeping the user's context when the current
 * section has a counterpart (admin board → mentor board) and falling back to the
 * target dashboard when it doesn't (mentor availability → admin home).
 */
export function counterpartPath(pathname: string, target: AppMode): string {
  const from = modeOf(pathname);
  if (!from || from === target) return `/${target}`;

  const section = pathname.split('/').filter(Boolean)[1];
  if (!section) return `/${target}`;

  if ((SHARED_SECTIONS as readonly string[]).includes(section)) return `/${target}/${section}`;

  const alias = ALIASES[from][section];
  return alias ? `/${target}/${alias}` : `/${target}`;
}
