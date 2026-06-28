// The landing route for a given role after sign-in.
export function roleHome(role?: string | null): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'MENTOR') return '/mentor';
  if (role === 'COMPANY') return '/company';
  return '/portal';
}
