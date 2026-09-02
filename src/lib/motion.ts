/**
 * Reduced-motion helper (#2045).
 *
 * `@media (prefers-reduced-motion: reduce)` in globals.css neutralises every CSS
 * animation and transition in the app, but it cannot touch scrolling that
 * JavaScript asks for explicitly: `scrollIntoView({ behavior: 'smooth' })` and
 * `window.scrollTo({ behavior: 'smooth' })` pass the behaviour as an argument,
 * which wins over the `scroll-behavior` property. Those call sites go through
 * `scrollBehavior()` instead of hardcoding `'smooth'`.
 */

/** True when the user asked their OS to reduce motion. False during SSR. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The `behavior` to pass to a programmatic scroll: instant under reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
