import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';
import { EMBED_MARKER, isEmbedSessionEnabled, rewriteSessionSetCookies, secureCookies } from '@/lib/embedSession';

const handler = NextAuth(authOptions);

// The Teams tab's session (#1954, src/lib/embedSession.ts): a request the
// middleware marked as riding the embed cookie must never be answered with
// NextAuth's own session cookie — a session refresh inside Teams would
// otherwise mint a first-party `SameSite=Lax` session. Its session Set-Cookie
// is rewritten to the embed cookie; everything else passes untouched. While
// Teams SSO is not configured this is the bare NextAuth handler.
async function route(req: Request, ctx: unknown) {
  const res: Response = await (handler as (req: Request, ctx: unknown) => Promise<Response>)(req, ctx);
  if (!isEmbedSessionEnabled() || req.headers.get(EMBED_MARKER) !== '1') return res;
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  for (const c of rewriteSessionSetCookies(cookies, secureCookies())) headers.append('set-cookie', c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export { route as GET, route as POST };
