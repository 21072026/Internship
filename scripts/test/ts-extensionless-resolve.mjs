// A resolve hook for `node --test --experimental-strip-types` (#1965).
//
// WHY THIS EXISTS
//   Node's own test runner strips TypeScript, which is why every unit test in
//   this directory can import a `src/lib/*.ts` module with no build step and no
//   dependency. What it does NOT do is resolve a specifier the way the app's
//   bundler does: in ESM, `import … from './importPreview'` is an error, because
//   the extension is part of the specifier. Every unit-tested module so far
//   happened to have no relative imports at all, so the gap never showed.
//
//   `src/lib/rosterIngest.ts` cannot be one of those modules: it is deliberately
//   built ON the shared import engine (`./importPreview`) and the shared
//   do-not-clobber policy (`./externalSyncPolicy`) rather than carrying copies
//   of them, which is the whole point of the engine.
//
//   The two ways out were to teach the *application* to write `./importPreview.ts`
//   in its imports (a repo-wide convention change, for the benefit of the test
//   runner) or to teach the *test runner* to resolve what the bundler already
//   resolves. This is the second one: it changes nothing about how the app is
//   compiled or shipped.
//
// HOW TO USE IT — from a test file, before touching the module under test:
//
//   import { register } from 'node:module';
//   register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
//   const { diffRoster } = await import('../../src/lib/rosterIngest.ts');
//
//   The imports must be dynamic and come after `register()`: static imports are
//   hoisted, so they would be resolved before the hook is installed.
//
// It also resolves the `@/…` path alias (#2264): `tsconfig.json` maps it to
// `src/`, and a module reached transitively by a unit test — `src/lib/pipeline`
// imports `@/i18n` — has no reason to spell its imports differently just
// because a test might load it. The mapping is read from the alias' single
// definition rather than restated, so a change there cannot leave this behind.
//
// It only ever runs as a FALLBACK, after Node's own resolution has already
// failed, and only for a relative or aliased specifier with no extension — so
// it cannot mask a genuinely missing module or shadow a real file.
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);

// tsconfig.json has comments, which JSON.parse does not; only the one entry is
// needed, so read it rather than pulling in a JSON5 dependency.
const ALIAS_TARGET = (() => {
  const tsconfig = readFileSync(new URL('tsconfig.json', ROOT), 'utf8');
  const paths = /"@\/\*"\s*:\s*\[\s*"([^"]+)"/.exec(tsconfig);
  if (!paths) throw new Error('tsconfig.json no longer maps "@/*" — update ts-extensionless-resolve.mjs');
  return paths[1].replace(/\*$/, '');
})();

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = new URL(ALIAS_TARGET + specifier.slice(2), ROOT);
    return resolve(target.href, context, nextResolve);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:');
    const extensionless = !/\.[cm]?[jt]sx?$/.test(specifier);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && relative && extensionless) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
