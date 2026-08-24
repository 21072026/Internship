// Where "open profile" goes for one viewer looking at one person (#1166).
//
// There is no single profile route in this app — an admin reads a mentee at
// /admin/candidates/<id> and a mentor reads the same mentee at
// /mentor/mentees/<id> — so every call site that wanted to link a name had to
// re-derive the target, and most simply did not link it at all. The mapping
// lives here so adding a role or a route is one edit, not a search-and-replace.
//
// Returns null when the viewer has no page for that person; callers render the
// name as plain text rather than a link that 404s or 403s.
export function personHref(
  viewerRole: string | null | undefined,
  person: { id: string; role?: string | null; relationId?: string | null }
): string | null {
  const role = person.role ?? 'MENTEE';

  if (viewerRole === 'ADMIN') {
    if (role === 'MENTEE') return `/admin/candidates/${person.id}`;
    if (role === 'MENTOR') return `/admin/mentors/${person.id}`;
    // Admins have no per-user page for COMPANY/SOURCE accounts; the user list is
    // the closest thing, and sending them to a 404 would be worse than nothing.
    return null;
  }

  // A mentor's own mentee. That route is keyed by the *relation*, not by the
  // person (/mentor/mentees/<relationId>), so it can only be offered when the
  // caller knows which relation — the card endpoint supplies it for the mentor
  // who owns it. Without one there is no mentor-side page for this person, and
  // a link built from the user id would land on "relation not found".
  if (viewerRole === 'MENTOR' && role === 'MENTEE') {
    return person.relationId ? `/mentor/mentees/${person.relationId}` : null;
  }

  return null;
}
