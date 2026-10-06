import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { useSession } from '../lib/session';
import { strings } from '../lib/i18n';
import { nativeRouteFor, NAV_HOOK_JS, parseOpenMessage, type NativeRoute } from '../lib/nativeRoutes';
import { openNative } from '../lib/openNative';
import { isSameOrigin } from '../lib/products';
import { useAppTheme } from '../lib/theme';
import { AFTER_LOAD_JS, parsePageMeta, pageTitle, type PageMeta } from '../lib/webMeta';

/**
 * The hybrid half of the app (#2775): a page of the chosen product's web app,
 * signed in through the same OS cookie jar the native screens use. Used for
 * every surface that is not native yet, and for the long tail (admin, pipeline
 * board, analytics) that stays on the web on purpose.
 *
 * Rules:
 *  - it never leaves the product's origin — any other URL goes to the system
 *    browser, because this view carries the product's session;
 *  - it notices a lost session (the page lands on /auth/signin) and hands
 *    control back to the native sign-in instead of showing the web form;
 *  - the page knows it is inside the app (the User-Agent marker; see
 *    lib/webMeta.ts): it drops its own top bar and drawer, and tells the app
 *    its title and colours, which `onMeta` hands to the native header;
 *  - a way into messages or notifications opens the NATIVE screen, however the
 *    page took it — a link, a "send message" button, a redirect
 *    (lib/nativeRoutes.ts). The web view steps back to where it was, or, when
 *    it has nothing to step back to and `replaceable` says it is a screen of
 *    its own, gives its place to the native one.
 */
export function WebScreen({
  path,
  onMeta,
  replaceable = false,
}: {
  path: string;
  onMeta?: (meta: PageMeta) => void;
  replaceable?: boolean;
}) {
  const { origin, product, signOut } = useSession();
  const { c } = useAppTheme();
  const t = strings();
  const ref = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const canGoBackRef = useRef(false);
  const loadedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  // Android's back button walks the page history before leaving the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) {
        ref.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  const onNav = useCallback(
    (nav: WebViewNavigation) => {
      setCanGoBack(nav.canGoBack);
      canGoBackRef.current = nav.canGoBack;
      if (origin && isSameOrigin(nav.url, origin) && new URL(nav.url).pathname.startsWith('/auth/signin')) {
        // The session is gone (expired, signed out elsewhere, revoked): the
        // native sign-in owns that moment, not the web form.
        void signOut();
      }
    },
    [origin, signOut],
  );

  // A way into a native screen: open it there, and leave nothing of it in the
  // web view. `shown` says the web view already displays that path (the page
  // loaded at it); otherwise the web view never left the page it was on —
  // unless it had not shown anything yet, which is the same as having nothing
  // to step back to.
  const handOver = useCallback(
    (route: NativeRoute, shown: boolean) => {
      const blank = shown ? !canGoBackRef.current : !loadedRef.current;
      if (!blank) {
        if (shown) ref.current?.goBack();
        openNative(route);
      } else if (replaceable) {
        openNative(route, { replace: true });
      } else {
        // A tab's own page (it never starts at a native path): go home.
        openNative(route);
        if (shown) ref.current?.injectJavaScript(`location.replace(${JSON.stringify(`${origin}${path}`)}); true;`);
      }
    },
    [origin, path, replaceable],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const open = parseOpenMessage(e.nativeEvent.data);
      if (open) {
        handOver(open.route, open.load);
        return;
      }
      const meta = parsePageMeta(e.nativeEvent.data);
      if (meta && onMeta) onMeta({ ...meta, title: pageTitle(meta.title, product?.name ?? '') });
    },
    [onMeta, product, handOver],
  );

  if (!origin) return null;

  if (failed) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Text style={{ color: c.muted, textAlign: 'center' }}>{t.offline}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setFailed(false);
            ref.current?.reload();
          }}
          style={[styles.retry, { backgroundColor: product?.color ?? '#1D4ED8' }]}
        >
          <Text style={styles.retryText}>{t.retry}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <WebView
      ref={ref}
      source={{ uri: `${origin}${path}` }}
      style={{ backgroundColor: c.bg }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled={false}
      // How the site knows it is inside the app (src/lib/embeddedApp.ts on the
      // server): it renders <html data-embedded-app> and drops its own chrome.
      applicationNameForUserAgent="InternCRMApp/1"
      injectedJavaScriptBeforeContentLoaded={NAV_HOOK_JS}
      injectedJavaScript={AFTER_LOAD_JS}
      onMessage={onMessage}
      pullToRefreshEnabled
      startInLoadingState
      renderLoading={() => (
        <View style={[styles.center, { backgroundColor: c.bg }]}>
          <ActivityIndicator />
        </View>
      )}
      onNavigationStateChange={onNav}
      onShouldStartLoadWithRequest={(req) => {
        if (isSameOrigin(req.url, origin)) {
          // A full load of a native path (location.href = …, a server
          // redirect): never let the web view render it.
          const u = new URL(req.url);
          const route = req.isTopFrame === false ? null : nativeRouteFor(u.pathname + u.search);
          if (!route) return true;
          handOver(route, false);
          return false;
        }
        if (req.url === 'about:blank') return true;
        void Linking.openURL(req.url);
        return false;
      }}
      onLoadEnd={() => {
        loadedRef.current = true;
      }}
      onError={() => setFailed(true)}
      setSupportMultipleWindows={false}
      allowsBackForwardNavigationGestures
    />
  );
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  retry: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: '#fff', fontWeight: '600' },
});
