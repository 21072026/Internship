// Which web paths the app opens natively instead of in the web view (#2775).
// Dependency-free so `npm test` pins it.
//
// A page inside the app links to messages in many ways: a plain <a>, a Next
// <Link>, a "send message" button that creates the conversation and then calls
// router.push(), a server redirect from the legacy /messages/<relationId> URL.
// They all end at one of the paths below. The web view asks this rule about
// every one of them (WebScreen + NAV_HOOK_JS), and so does a notification tap,
// so "open a conversation" means the native thread wherever it starts.

export type NativeRoute =
  | { kind: 'thread'; id: string }
  | { kind: 'tab'; tab: 'messages' | 'notifications' };

/**
 * The native screen for a same-site path, or null for a page that stays on the
 * web. `/messages/support` and the legacy `/messages/<relationId>` stay on the
 * web: the first has no native screen, the second redirects to `/messages/c/<id>`
 * once the server has resolved it, and that hop is caught in turn.
 */
export function nativeRouteFor(path: string | null | undefined): NativeRoute | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const thread = /^\/messages\/c\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (thread) return { kind: 'thread', id: thread[1] };
  if (pathname === '/messages') return { kind: 'tab', tab: 'messages' };
  if (pathname === '/notifications') return { kind: 'tab', tab: 'notifications' };
  return null;
}

/** The same rule as a regular expression the page can run on its own. */
export const NATIVE_PATH_SOURCE = '^/(messages(/c/[A-Za-z0-9_-]+)?|notifications)/?$';

/**
 * Injected before the page's own scripts. A tap on a link to a native path is
 * stopped before the site's router sees it and handed to the app; a
 * programmatic navigation (router.push after a fetch, a redirect's
 * replaceState) cannot be
 * stopped without confusing the site's router, so it is let through, reported,
 * and undone with history.back() — the app is already sliding the native screen
 * over it. A page that LOADS at a native path is reported too (`load: true`);
 * the app decides how to step back from it, since only it knows whether there
 * is anything to go back to.
 */
export const NAV_HOOK_JS = `
  (function () {
    if (window.__internCrmNavHook) return;
    window.__internCrmNavHook = true;
    var re = new RegExp(${JSON.stringify(NATIVE_PATH_SOURCE)});
    function post(path, load) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'open', path: path, load: !!load }));
    }
    function sameSitePath(href) {
      try {
        var u = new URL(href, location.href);
        return u.origin === location.origin ? u.pathname + u.search : null;
      } catch (e) { return null; }
    }
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      var path = sameSitePath(a.getAttribute('href'));
      if (!path || !re.test(path.split('?')[0])) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post(path, false);
    }, true);
    // A redirect (legacy /messages/<relationId> → /messages/c/<id>) arrives as
    // replaceState; the site's router also calls it on the URL it is already
    // on, which is not a navigation and is left alone.
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function (state, title, url) {
        var before = location.pathname;
        var r = original.apply(this, arguments);
        var path = url == null ? null : sameSitePath(String(url));
        if (path && re.test(path.split('?')[0]) && (name === 'pushState' || path.split('?')[0] !== before)) {
          post(path, false);
          setTimeout(function () { history.back(); }, 0);
        }
        return r;
      };
    });
    if (re.test(location.pathname)) post(location.pathname + location.search, true);
  })();
  true;
`;

/** Parse an `open` message from the page; anything else is null. */
export function parseOpenMessage(data: string): { route: NativeRoute; load: boolean } | null {
  try {
    const msg = JSON.parse(data) as { type?: unknown; path?: unknown; load?: unknown };
    if (msg.type !== 'open' || typeof msg.path !== 'string') return null;
    const route = nativeRouteFor(msg.path);
    return route ? { route, load: msg.load === true } : null;
  } catch {
    return null;
  }
}
