// "View mode": the shells one account can move between — admin, mentor, and
// (#1141) the mentee portal, for someone who mentors and is mentored in turn.
//
// Which modes a given user may use is decided server-side in `dualRole.ts`; this
// module only knows how to name a mode and where to land when switching. The
// mode is *derived from the URL*, never stored. That keeps the sidebar, the page
// and the address bar from disagreeing: there is no persisted flag that can go
// stale when a link (a notification, a bookmark) drops the user straight into
// another mode.

export type AppMode = 'admin' | 'mentor' | 'mentee';

/** The shell each mode lives under. */
export const MODE_ROOT: Record<AppMode, string> = {
  admin: '/admin',
  mentor: '/mentor',
  mentee: '/portal',
};

/**
 * Sections each shell actually has, by slug. A section is only carried across a
 * switch when the *target* shell really owns that page — the portal has far
 * fewer sections than the two staff shells, and linking to a /portal page that
 * doesn't exist would turn the switch into a 404.
 */
const SECTIONS: Record<AppMode, readonly string[]> = {
  admin: ['board', 'projects', 'meetings', 'calendar', 'email', 'mentee-activity', 'analytics'],
  mentor: ['board', 'projects', 'meetings', 'calendar', 'email', 'mentee-activity', 'analytics'],
  mentee: ['projects', 'messages', 'notes', 'interactions', 'profile'],
};

/**
 * Sections whose counterpart lives under a different slug. Only the pairs where
 * the two pages really answer the same question are mapped; anything else falls
 * back to the mode's dashboard rather than guessing.
 */
const ALIASES: Record<AppMode, Partial<Record<AppMode, Record<string, string>>>> = {
  admin: {
    // Viewing candidates/mentorships as an admin → the mentees you personally mentor.
    mentor: { candidates: 'mentees', mentorship: 'mentees' },
  },
  // Your own mentees → the full candidate list.
  mentor: { admin: { mentees: 'candidates' } },
  mentee: {},
};

/** The mode a pathname belongs to, or null for pages outside every shell. */
export function modeOf(pathname: string): AppMode | null {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/mentor' || pathname.startsWith('/mentor/')) return 'mentor';
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return 'mentee';
  return null;
}

/**
 * Where the mode switch should land, keeping the user's context when the current
 * section has a counterpart (admin board → mentor board) and falling back to the
 * target dashboard when it doesn't (mentor availability → admin home).
 */
export function counterpartPath(pathname: string, target: AppMode): string {
  const root = MODE_ROOT[target];
  const from = modeOf(pathname);
  if (!from || from === target) return root;

  const section = pathname.split('/').filter(Boolean)[1];
  if (!section) return root;

  if (SECTIONS[target].includes(section)) return `${root}/${section}`;

  const alias = ALIASES[from][target]?.[section];
  return alias ? `${root}/${alias}` : root;
}
