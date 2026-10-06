import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useSession } from '../lib/session';
import { strings } from '../lib/i18n';
import { isSameOrigin } from '../lib/products';

/**
 * The hybrid half of the app (#2775): a page of the chosen product's web app,
 * signed in through the same OS cookie jar the native screens use. Used for
 * every surface that is not native yet, and for the long tail (admin, pipeline
 * board, analytics) that stays on the web on purpose.
 *
 * Two rules:
 *  - it never leaves the product's origin — any other URL goes to the system
 *    browser, because this view carries the product's session;
 *  - it notices a lost session (the page lands on /auth/signin) and hands
 *    control back to the native sign-in instead of showing the web form.
 */
export function WebScreen({ path }: { path: string }) {
  const { origin, signOut } = useSession();
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

  if (!origin) return null;

  if (failed) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{t.offline}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setFailed(false);
            ref.current?.reload();
          }}
          style={styles.retry}
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
      sharedCookiesEnabled
      thirdPartyCookiesEnabled={false}
      pullToRefreshEnabled
      startInLoadingState
      renderLoading={() => (
        <View style={styles.center}>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  muted: { color: '#6b7280', textAlign: 'center' },
  retry: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1D4ED8' },
  retryText: { color: '#fff', fontWeight: '600' },
});
