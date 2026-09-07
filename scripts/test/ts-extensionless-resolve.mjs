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
// It only ever runs as a FALLBACK, after Node's own resolution has already
// failed, and only for a relative specifier with no extension — so it cannot
// mask a genuinely missing module or shadow a real file.

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    const extensionless = !/\.[cm]?[jt]sx?$/.test(specifier);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && relative && extensionless) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
