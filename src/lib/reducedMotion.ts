/**
 * The JS-side reader of `prefers-reduced-motion` (#2045).
 *
 * WHY THIS EXISTS: the blanket rule in globals.css collapses every CSS
 * animation and transition, but it cannot reach a *scripted* scroll. An
 * explicit `behavior: 'smooth'` in `ScrollOptions` overrides the page's
 * `scroll-behavior`, so the two auto-scrolls in the app (the message thread
 * jumping to the newest bubble, the project editor jumping back to its form)
 * would keep gliding for someone who asked their OS to stop moving things.
 * Those are exactly the unrequested, self-starting movements the preference is
 * about, so they ask here instead of hardcoding 'smooth'.
 *
 * Read at call time, not cached: the preference can change while the tab is
 * open, and there is no cheap way to notice that from a module-level constant.
 * Returns false when there is no `window` (SSR) or no `matchMedia`, so the
 * default is the unchanged animated path.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The `behavior` to pass to `scrollIntoView` / `scrollTo` for a scroll the user
 * did not ask for: instant when motion is unwanted, smooth otherwise.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
