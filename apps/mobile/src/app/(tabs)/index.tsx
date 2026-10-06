import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { strings } from '../../lib/i18n';
import { roleHome, roleSection } from '../../lib/roleHome';
import { useSession } from '../../lib/session';
import { useAppTheme, type Palette } from '../../lib/theme';

type IconName = keyof typeof Ionicons.glyphMap;

// Native home (#2775). Shortcuts open the web page for now; each one becomes a
// native screen in its own slice of the epic.
export default function HomeTab() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { user, product } = useSession();
  const t = strings();
  const tint = product?.color ?? '#1D4ED8';
  const firstName = (user?.name ?? '').split(' ')[0] || user?.email || '';

  const open = (path: string, title: string) =>
    path === '/notifications' ? router.navigate('/notifications') : router.push({ pathname: '/web', params: { path, title } });

  const tiles: { icon: IconName; label: string; path: string | null }[] = [
    { icon: 'notifications', label: t.notifications, path: '/notifications' },
    { icon: 'calendar', label: t.calendar, path: roleSection(user?.role, 'calendar') },
    { icon: 'person-circle', label: t.profile, path: roleSection(user?.role, 'profile') },
    { icon: 'grid', label: t.openOnWeb, path: roleHome(user?.role) },
  ];

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.hello} accessibilityRole="header">
        {t.hello.replace('{name}', firstName)}
      </Text>
      <Text style={styles.hint}>{t.homeHint}</Text>
      <View style={styles.grid}>
        {tiles
          .filter((tile): tile is { icon: IconName; label: string; path: string } => tile.path !== null)
          .map((tile) => (
            <Pressable
              key={tile.label}
              accessibilityRole="button"
              onPress={() => open(tile.path, tile.label)}
              style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Ionicons name={tile.icon} size={28} color={tint} />
              <Text style={styles.tileText}>{tile.label}</Text>
            </Pressable>
          ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  body: { padding: 20, gap: 8 },
  hello: { fontSize: 26, fontWeight: '800', color: c.text },
  hint: { color: c.muted, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: {
    width: '47%',
    borderRadius: 14,
    padding: 18,
    gap: 10,
    backgroundColor: c.subtle,
  },
  tileText: { fontWeight: '600', color: c.text },
});
