// Runs in the browser before any of the app's own modules (Next's client
// instrumentation hook). Only what must precede every import belongs here.
//
// zod's browser config (#3642): zod decides whether it may JIT-compile while a
// `z.object(...)` is being CONSTRUCTED, and many schemas are constructed at module
// load — on the sign-in page before src/app/providers.tsx ever runs. Installed
// there, the `new Function` probe had already happened, and the strict
// report-only CSP had already reported it. Here it precedes them all.
import { installBrowserZodConfig } from './lib/zodBrowserConfig';

installBrowserZodConfig();
