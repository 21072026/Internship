import pkg from '../../package.json';

// The displayed version is BASE (package.json) plus any pending release
// fragments, derived in next.config.js at build time and inlined here via env
// (#1275) — so it is correct even before the scheduled compaction PR folds the
// fragments into package.json. The package.json fallback covers contexts that
// run without the Next build (scripts, tests importing this module directly).
// GIT_SHA is baked into the Docker image at build time (see Dockerfile /
// deploy workflows); 'dev' locally.
export const APP_VERSION: string = process.env.APP_DERIVED_VERSION || pkg.version;
export const GIT_SHA: string = (process.env.GIT_SHA || 'dev').slice(0, 7);
