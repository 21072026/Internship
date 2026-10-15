// The current request's session, decoded once per server render (#2922).
//
// next-auth v4 does not memoize getServerSession(), and its `jwt` callback
// reads the user row (the sessionsValidFrom / world check in src/lib/auth.ts),
// so every independent call is a decode plus a query. The readers that only
// need "who is signed in" for presentation — the request's vertical
// (src/i18n/server.ts) and its brand (src/lib/hostBrand.ts) — share this one,
// wrapped in React's per-request cache(). Outside a React server render (a
// route handler, a script) cache() is a pass-through, which is the old cost.
//
// Authorization decisions keep calling getServerSession() themselves; this is
// the same value, but a gate should not depend on a render-scoped memo.
import 'server-only';
import { cache } from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const requestSession = cache(() => getServerSession(authOptions));
