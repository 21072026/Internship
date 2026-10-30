/**
 * The target guard and the demo sign-in shared by the authenticated k6
 * scenarios (#1612): k6/authenticated-load.js and k6/sse-load.js.
 *
 * THE ONLY LEGAL TARGET IS THE DEMO ENVIRONMENT. These scenarios sign in and
 * write rows, so a reflexive `k6 run` must be unable to reach production or the
 * shared preview: `assertDemoTarget()` throws in setup() for any host that is
 * not on DEMO_HOSTS, which aborts the run before a single VU starts. A local
 * dev server (localhost / 127.0.0.1) is accepted only with K6_ALLOW_LOCAL=1, so
 * a script change can be checked against `npm run dev` + `npm run seed:demo`.
 *
 * The credentials are the demo's PUBLISHED ones (docs/DEMO.md, prisma/seed-demo.mjs):
 * every demo account shares one password, printed on the demo's own sign-in
 * page. They are not secrets, and nothing here may ever be pointed at an
 * environment whose passwords are.
 */
import http from 'k6/http';

export const DEMO_HOSTS = ['demo.interncrm.com'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export const DEMO_PASSWORD = __ENV.K6_DEMO_PASSWORD || 'DemoPass123!';
const DOMAIN = 'demo.example.com';

export const DEMO_ACCOUNTS = {
  admin: [`admin.demo@${DOMAIN}`],
  mentor: ['aylin', 'baran', 'ceyda'].map((n) => `mentor.${n}@${DOMAIN}`),
  mentee: ['deniz', 'efe', 'firat', 'gizem', 'hakan', 'irem', 'kaan', 'lale'].map((n) => `mentee.${n}@${DOMAIN}`),
};

export function baseUrl() {
  return (__ENV.BASE_URL || `https://${DEMO_HOSTS[0]}`).replace(/\/+$/, '');
}

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

/** Throws unless `url` is the demo (or, with K6_ALLOW_LOCAL=1, a local dev server). */
export function assertDemoTarget(url) {
  const host = hostOf(url);
  if (DEMO_HOSTS.includes(host)) return;
  if (__ENV.K6_ALLOW_LOCAL === '1' && LOCAL_HOSTS.includes(host)) return;
  throw new Error(
    `refusing to run: ${host || url} is not the demo environment (${DEMO_HOSTS.join(', ')}). ` +
      'These scenarios sign in and write rows; they may only ever target the demo.'
  );
}

const SESSION_COOKIES = ['__Secure-next-auth.session-token', 'next-auth.session-token'];

/**
 * Signs one demo account in through NextAuth's credentials callback and returns
 * the session cookie as a `Cookie` header value, or null. Each call costs one
 * bcrypt comparison on the server — the scenarios call it a handful of times in
 * setup(), never per iteration.
 */
export function signIn(base, email, tags) {
  const jar = http.cookieJar();
  const csrf = http.get(`${base}/api/auth/csrf`, { tags, responseType: 'text' });
  let token = '';
  try {
    token = JSON.parse(csrf.body).csrfToken || '';
  } catch {
    return null;
  }
  http.post(
    `${base}/api/auth/callback/credentials`,
    { csrfToken: token, email, password: DEMO_PASSWORD, json: 'true' },
    { tags, redirects: 0, responseType: 'text' }
  );
  const cookies = jar.cookiesForURL(base);
  for (const name of SESSION_COOKIES) {
    if (cookies[name] && cookies[name][0]) {
      const value = cookies[name][0];
      jar.clear(base);
      return `${name}=${value}`;
    }
  }
  jar.clear(base);
  return null;
}
