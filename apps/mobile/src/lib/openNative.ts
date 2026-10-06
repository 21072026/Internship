import { router } from 'expo-router';
import type { NativeRoute } from './nativeRoutes';

/**
 * Open the native screen `nativeRouteFor()` chose (#2775). `replace` takes the
 * place of the current screen — for a web screen that has nothing else to show
 * (it was opened at a URL that only led here).
 */
export function openNative(route: NativeRoute, { replace = false }: { replace?: boolean } = {}): void {
  if (route.kind === 'thread') {
    const target = { pathname: '/thread/[id]' as const, params: { id: route.id } };
    if (replace) router.replace(target);
    else router.push(target);
    return;
  }
  if (replace && router.canGoBack()) router.back();
  router.navigate(route.tab === 'messages' ? '/messages' : '/notifications');
}
