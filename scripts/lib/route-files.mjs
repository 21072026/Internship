// The one walker over the App Router's route handlers.
//
// Two guards read the same tree and must see exactly the same set of files:
// scripts/check-api-key-routes.mjs (#1546 — every /api/v1 route enters through
// withApiKey) and scripts/check-route-auth.mjs (#2444 — every exported handler
// asks who is calling). A second, slightly different walker is how a route ends
// up invisible to one of them while looking covered, so there is only this one.
//
// Paths come back POSIX-separated and sorted, so a failure message reads the
// same on every machine.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `route.ts` under `dir`, recursively.
 * @param {string} dir directory to walk (e.g. 'src/app/api')
 * @returns {string[]} file paths, POSIX-separated, sorted
 */
export function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (entry === 'route.ts') out.push(path);
  }
  return out.map((p) => p.replace(/\\/g, '/')).sort();
}
