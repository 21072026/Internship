// The web dashboard each role lands on — a copy of src/lib/roleHome.ts (the app
// cannot import the web's '@/…' paths). Pinned against the original by
// src/lib/roleHome.test.ts.
export function roleHome(role?: string | null): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'MENTOR') return '/mentor';
  if (role === 'COMPANY') return '/company';
  if (role === 'SOURCE') return '/source';
  return '/portal';
}

/** Where a role's own calendar and profile live on the web; null when it has none. */
export function roleSection(role: string | null | undefined, page: 'calendar' | 'profile'): string | null {
  if (role === 'MENTOR') return `/mentor/${page}`;
  if (role === 'MENTEE') return `/portal/${page}`;
  return null;
}
