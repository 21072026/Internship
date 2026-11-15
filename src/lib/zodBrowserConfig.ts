// Zod in the browser runs without its JIT (#3642, docs/csp.md).
//
// Zod 4 compiles object schemas with `new Function` when it may. To find out, it
// probes `new Function("")` once (zod/v4/core/util.js, `allowsEval`) — and it does
// so while a `z.object()` is CONSTRUCTED, not on the first parse: the `$ZodObject`
// initializer reads `allowsEval.value` (zod/v4/core/schemas.js). The strict
// report-only CSP (src/lib/cspPolicy.cjs, #1552) has no 'unsafe-eval' in
// production, so the browser reports that probe as a `securitypolicyviolation`
// even though zod swallows the throw — one report per page view that builds a
// schema, the sign-in page above all (its schemas are built at module load).
// The reports filled `/api/csp-report`'s per-IP limit in CI, every later one got
// a 429, and the smoke test read that as a console error on whichever page came
// next.
//
// `jitless` skips both the probe and the JIT, but only for schemas built AFTER it
// is set — hence where it is set (below). e2e/csp-signin-no-eval.spec.ts holds
// the page to it: no `eval` violation and no `eval` report on /auth/signin.
// Nothing is lost: once the strict policy is enforced, `eval` is refused in the
// browser anyway, and a form's few fields never needed a compiled parser. The
// server keeps the JIT (src/instrumentation.ts does not call this).
//
// WHERE: src/instrumentation-client.ts, which Next runs before the app's own
// modules. zod probes while a `z.object()` is constructed, and schemas are built
// at module load, so installing this from a component (the first attempt, in
// providers.tsx) was too late on the sign-in page.
import { z } from 'zod';

export function installBrowserZodConfig(): void {
  z.config({ jitless: true });
}
