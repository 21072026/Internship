## 2026-10-28 — moving unit specs off Playwright (#1598, #1592)

- **Re-read an old issue's premise before building what it asks for.** #1598 asked for
  Vitest. In the meantime the repo had settled on `node --test --experimental-strip-types`,
  with a resolve hook for `@/` and a per-file coverage gate. A comment on the issue already
  said so. The work that was left was porting specs, not adding a runner.
- **Porting a `*.unit.spec.ts` is a short sed-like pass:** `expect(a).toBe(b)` → `assert.equal`,
  `.not.toBe` → `assert.notEqual`, `.toBeTruthy()` → `assert.ok`, drop `{ tag: '@smoke' }` and the
  TS annotations, and load `src` modules with a dynamic `import()` after
  `register('./ts-extensionless-resolve.mjs')`. Plain packages (`react`) can stay static imports.
- **The coverage gate tells you what to do next.** Once a module in `AWAITING_TESTS` is exercised,
  `npm run test:unit:coverage` fails and names the floor to write. Move the entry and lower
  `EXPECTED_AWAITING` in the same diff.
- **`main` can be red on the unit gate without anyone noticing** while Actions minutes are
  exhausted. Here `erasure-coverage` was failing: two features had added `@db.Text` columns
  without an erasure decision. Run `npm run test:unit` on a fresh `main` before blaming your own diff.
