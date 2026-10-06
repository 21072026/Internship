#!/usr/bin/env node
// Turns mobile/android/<app>/twa-manifest.json into a buildable Gradle project
// (docs/mobile-strategy.md, #2085).
//
// The twa-manifest.json is the only thing committed: the Gradle project is a
// pure function of it plus the Bubblewrap template, so regenerating it on every
// build is how a template update reaches the app without a 40-file diff here.
// This drives @bubblewrap/core directly rather than the `bubblewrap` CLI, which
// prompts for a JDK and an SDK on first run and so cannot run in CI.
//
// Usage: node mobile/android/generate-project.mjs <interncrm|salevali> <outDir> [versionCode] [versionName]
// Needs @bubblewrap/core installed (the workflow installs it with --no-save; it
// is deliberately not a dependency of the web app).

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwaManifest, TwaGenerator, ConsoleLog } from '@bubblewrap/core';

const [app, outDir, versionCode, versionName] = process.argv.slice(2);
if (!['interncrm', 'salevali'].includes(app) || !outDir) {
  console.error('usage: generate-project.mjs <interncrm|salevali> <outDir> [versionCode] [versionName]');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const manifest = await TwaManifest.fromFile(resolve(here, app, 'twa-manifest.json'));
if (versionCode) {
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code < 1) throw new Error(`versionCode must be a positive integer, got ${versionCode}`);
  manifest.appVersionCode = code;
  manifest.appVersionName = versionName || String(code);
}
const error = manifest.validate();
if (error) throw new Error(`twa-manifest.json is invalid: ${error}`);

await new TwaGenerator().createTwaProject(resolve(outDir), manifest, new ConsoleLog('twa'));
console.log(`Generated ${manifest.packageId} ${manifest.appVersionName} (${manifest.appVersionCode}) → ${outDir}`);
