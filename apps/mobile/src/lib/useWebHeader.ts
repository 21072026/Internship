import { useNavigation } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback } from 'react';
import { useAppTheme } from './theme';
import { isDarkColor, type PageMeta } from './webMeta';

/**
 * The native header of a screen that hosts a WebScreen (#2775): the page's own
 * title (no empty placeholder bar) on the page's own background, so a dark page
 * never sits under a white header — whatever theme the person picked on the
 * site. Until the page reports, the screen keeps the app theme and `fallback`.
 */
export function useWebHeader(fallback = ''): (meta: PageMeta) => void {
  const navigation = useNavigation();
  const { c } = useAppTheme();
  return useCallback(
    (meta: PageMeta) => {
      const bg = meta.bg ?? (meta.dark ? '#030712' : c.card);
      const darkBg = meta.dark || isDarkColor(bg);
      const fg = darkBg ? '#f3f4f6' : '#111827';
      navigation.setOptions({
        title: meta.title || fallback,
        headerStyle: { backgroundColor: bg },
        headerTintColor: fg,
        headerTitleStyle: { color: fg },
        headerShadowVisible: false,
      });
      setStatusBarStyle(darkBg ? 'light' : 'dark');
    },
    [navigation, c.card, fallback],
  );
}
