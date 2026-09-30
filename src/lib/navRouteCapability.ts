// Route → vertical capability, derived from the nav catalogue (#2351 follow-up).
//
// The sidebar hides a link whose capability the tenant's vertical lacks, but
// hiding is not access control: the URL still answers. This is the rule the
// server-side PAGE gate reads (src/lib/pageCapabilityGate.ts), and it is derived
// from the very same `NavLink` list the sidebar filters — so a module switched
// off in the nav is switched off at its URL by the same entry, and there is no
// second route table to drift.
//
// PURE and dependency-free on purpose (a structural `{ href, capability }`
// shape, no lucide/alias imports), so `node --test --experimental-strip-types`
// can load it — scripts/test/nav-route-capability.test.mjs.

export interface RouteCapabilityLink<C extends string = string> {
  href: string;
  capability?: C;
}

/** Does `pathname` sit at or under `href`? Segment-wise: `/admin/email` does not own `/admin/emails`. */
export function pathIsUnder(pathname: string, href: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  const h = href.replace(/\/+$/, '') || '/';
  if (p === h) return true;
  return p.startsWith(h === '/' ? '/' : `${h}/`);
}

/**
 * The capability a pathname needs, or null when it needs none. The LONGEST
 * matching link wins, so a tagged child route is never shadowed by an untagged
 * parent (and vice versa). A pathname no link covers needs no capability: the
 * gate only ever closes what the nav already tags.
 */
export function capabilityForPath<C extends string>(
  links: readonly RouteCapabilityLink<C>[],
  pathname: string,
): C | null {
  let best: RouteCapabilityLink<C> | null = null;
  for (const link of links) {
    if (!pathIsUnder(pathname, link.href)) continue;
    if (!best || link.href.length > best.href.length) best = link;
  }
  return best?.capability ?? null;
}

/** May a tenant with `caps` open `pathname`? The page gate's whole decision. */
export function pathAllowed<C extends string>(
  links: readonly RouteCapabilityLink<C>[],
  pathname: string,
  caps: readonly C[],
): boolean {
  const needed = capabilityForPath(links, pathname);
  return needed === null || caps.includes(needed);
}
