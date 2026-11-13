// Runs in the browser before the app hydrates (Next.js `instrumentation-client`).
//
// zod 4 compiles object parsers with `new Function` when it may, and finds out
// whether it may by calling `Function("")` inside a try/catch the first time an
// object schema is built. Under the strict CSP (#1552, docs/csp.md) that probe is
// a `script-src` 'eval' violation: blocked and swallowed when enforced, but it
// was the ONLY violation the report stream ever carried, on every page with a
// form. `jitless` skips the probe and the JIT; zod then parses with its ordinary
// interpreter, which is what it falls back to under the CSP anyway. The server
// is not affected (this file is browser-only), so API validation keeps the JIT.
//
// `zod/v4/core` is the module `zod` itself is built on — one copy in the tree
// (`npm ls zod`), so this config is the one every schema reads.
import { config } from 'zod/v4/core';

config({ jitless: true });
