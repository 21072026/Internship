// The landing route for a given role after sign-in.
export function roleHome(role?: string | null): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'MENTOR') return '/mentor';
  if (role === 'COMPANY') return '/company';
  if (role === 'SOURCE') return '/source';
  // Named explicitly: the fallback below is the mentee portal, and an affiliate
  // must never land there.
  if (role === 'AFFILIATE') return '/affiliate';
  return '/portal';
}
