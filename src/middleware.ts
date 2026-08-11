import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { IS_DEMO_MODE, isDemoAllowlisted } from '@/lib/demoMode';

// Methods that mutate state. Unverified users are limited to reads.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Endpoints a logged-in-but-unverified user must still be able to call:
// the whole auth surface (sign in/out, forgot/reset, verify + resend).
function isAllowlisted(pathname: string) {
  return (
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/register' ||
    // Returning from impersonation must work even if the impersonated user is
    // unverified (the impersonated identity could be a read-only account).
    pathname === '/api/impersonate/stop' ||
    // Public meeting RSVP (the unguessable token is the credential).
    pathname === '/api/rsvp' ||
    // Public mentee application form.
    pathname === '/api/apply' ||
    // Public profile view counter.
    pathname === '/api/profile-view' ||
    // Inbound email bridge (authenticated by HMAC reply token + shared secret).
    pathname === '/api/inbound-email'
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!WRITE_METHODS.has(req.method) || isAllowlisted(pathname)) {
    return NextResponse.next();
  }

  // Demo mode: block write operations that are not explicitly allowlisted
  // (sign-in and the reset endpoint must still work so visitors can explore
  // and the scheduler can reset the data). Only write methods reach this
  // point — reads short-circuit in the check above.
  if (IS_DEMO_MODE && WRITE_METHODS.has(req.method) && !isDemoAllowlisted(pathname)) {
    return NextResponse.json(
      { error: 'This is a read-only demo. Sign up at crm.ersah.in to get your own account.' },
      { status: 403 }
    );
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // Only block when we positively know the email is unverified. Anonymous
  // requests (token === null) are left to each route's own auth check, and
  // older sessions without the field (undefined) are treated as verified.
  if (token && token.emailVerified === false) {
    return NextResponse.json(
      { error: 'Please verify your email address to make changes.' },
      { status: 403 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
