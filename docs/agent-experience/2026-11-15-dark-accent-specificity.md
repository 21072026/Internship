## 2026-11-15 — dark mode: the accent layer overrode `dark:` utilities (#3745)

- **`<html data-accent>` is always set (blue by default), so the accent remap layer is always
  on.** `html[data-accent] .bg-blue-100` scores 0,2,1. Tailwind 3's class-mode `dark:` emits
  `.dark\:x:is(.dark *)`, which scores 0,2,0. Every `dark:` colour written next to a remapped blue
  utility therefore lost in dark mode, silently. Read the specificity from the built CSS
  (`grep 'dark\\:bg-blue-900' .next/static/css/*.css`) rather than from the docs.
- **Fix the cascade once rather than pinning 100+ elements with `dark:!`.** A zero-specificity
  guard, `:not(:where(.dark [class*="dark:bg-"]))`, makes a remap step aside only where the
  author wrote their own dark value. Nothing else about the cascade moves, so the
  `html.dark[data-accent]` legibility rules still win where they did.
- **Measure contrast with composited colours.** A `dark:bg-blue-900/40` background is
  translucent, so composite it over the first opaque ancestor before computing the WCAG ratio
  (`e2e/dark-mode.spec.ts`). Otherwise the alpha is ignored and the number is wrong.
- **MariaDB stops when the container restarts.** A "Can't reach database server" flood at
  WebServer start means `service mariadb start`, not a code problem.
