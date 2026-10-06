import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { useSession } from '../lib/session';
import { strings } from '../lib/i18n';
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
 *    its title and colours, which `onMeta` hands to the native header.
 */
export function WebScreen({ path, onMeta }: { path: string; onMeta?: (meta: PageMeta) => void }) {
  const { origin, product, signOut } = useSession();
  const { c } = useAppTheme();
  const t = strings();
  const ref = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
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
      if (origin && isSameOrigin(nav.url, origin) && new URL(nav.url).pathname.startsWith('/auth/signin')) {
        // The session is gone (expired, signed out elsewhere, revoked): the
        // native sign-in owns that moment, not the web form.
        void signOut();
      }
    },
    [origin, signOut],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const meta = parsePageMeta(e.nativeEvent.data);
      if (meta && onMeta) onMeta({ ...meta, title: pageTitle(meta.title, product?.name ?? '') });
    },
    [onMeta, product],
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
        if (isSameOrigin(req.url, origin) || req.url === 'about:blank') return true;
        void Linking.openURL(req.url);
        return false;
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
