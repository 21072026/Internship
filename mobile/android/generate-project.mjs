#!/usr/bin/env node
// Turns a twa-manifest.json into a buildable Gradle project
// (docs/mobile-strategy.md, #2085).
//
// The twa-manifest.json is the only thing committed: the Gradle project is a
// pure function of it plus the Bubblewrap template, so regenerating it on every
// build is how a template update reaches the app without a 40-file diff here.
// This drives @bubblewrap/core directly rather than the `bubblewrap` CLI, which
// prompts for a JDK and an SDK on first run and so cannot run in CI.
//
// Usage: node mobile/android/generate-project.mjs <app | path/to/twa-manifest.json> <outDir> [versionCode] [versionName]
//   <app>  a folder next to this script (today: interncrm), or the path of a
//          twa-manifest.json kept elsewhere (a deployment's own app, #2926).
//
// THE PACKAGE ID (#2926). Play binds an app to its package id forever, and the
// id names whoever publishes the app — so it is not written into the committed
// config, which carries a `com.example.*` placeholder. TWA_PACKAGE_ID sets the
// real one at build time. A release build (one given a versionCode) is refused
// while the package is still a placeholder: an upload under it would create a
// different, permanent Play listing.
//
// Needs @bubblewrap/core installed (the workflow installs it with --no-save; it
// is deliberately not a dependency of the web app).

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwaManifest, TwaGenerator, ConsoleLog } from '@bubblewrap/core';

const USAGE = 'usage: generate-project.mjs <app | path/to/twa-manifest.json> <outDir> [versionCode] [versionName]';
// A Java package name: two or more dot-separated identifiers, no hyphens.
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PLACEHOLDER_PACKAGE = /^com\.example\./;

const [app, outDir, versionCode, versionName] = process.argv.slice(2);
if (!app || !outDir) {
  console.error(USAGE);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = app.endsWith('.json') ? resolve(app) : /^[a-z0-9-]+$/.test(app) ? resolve(here, app, 'twa-manifest.json') : null;
if (!manifestPath || !existsSync(manifestPath)) {
  console.error(`no twa-manifest.json for "${app}"\n${USAGE}`);
  process.exit(2);
}

const manifest = await TwaManifest.fromFile(manifestPath);
const packageId = process.env.TWA_PACKAGE_ID?.trim();
if (packageId) {
  if (!PACKAGE_ID.test(packageId)) throw new Error(`TWA_PACKAGE_ID is not a Java package name: ${packageId}`);
  manifest.packageId = packageId;
}
if (versionCode) {
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code < 1) throw new Error(`versionCode must be a positive integer, got ${versionCode}`);
  if (PLACEHOLDER_PACKAGE.test(manifest.packageId)) {
    throw new Error(
      `refusing a release build under the placeholder package ${manifest.packageId}: set TWA_PACKAGE_ID to the app's Play package id`
    );
  }
  manifest.appVersionCode = code;
  manifest.appVersionName = versionName || String(code);
}
const error = manifest.validate();
if (error) throw new Error(`twa-manifest.json is invalid: ${error}`);

await new TwaGenerator().createTwaProject(resolve(outDir), manifest, new ConsoleLog('twa'));
console.log(`Generated ${manifest.packageId} ${manifest.appVersionName} (${manifest.appVersionCode}) → ${outDir}`);
