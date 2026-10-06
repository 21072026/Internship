import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiGet } from '../../lib/api';
import { strings } from '../../lib/i18n';
import { menuIcon, menuItems, type MenuItem } from '../../lib/menu';
import { useSession } from '../../lib/session';
import { useAppTheme } from '../../lib/theme';

// "More" (#2775): the person's web sidebar as a native list — the site hides
// its own drawer inside the app, so this is where its menu lives — followed by
// the account actions.
export default function MoreTab() {
  const { user, product, origin, signOut, clearProduct } = useSession();
  const { c } = useAppTheme();
  const t = strings();
  const tint = product?.color ?? '#1D4ED8';
  const [menu, setMenu] = useState<MenuItem[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (!origin) return;
      apiGet<{ items: MenuItem[] }>(origin, '/api/app/navigation')
        .then((r) => setMenu(menuItems(r.items)))
        .catch(() => {});
    }, [origin]),
  );

  const open = (path: string, title: string) => router.push({ pathname: '/web', params: { path, title } });

  const account: { label: string; icon: string; onPress: () => void; danger?: boolean }[] = [
    { label: t.account, icon: 'settings', onPress: () => open('/account', t.account) },
    { label: t.deleteAccount, icon: 'trash', onPress: () => open('/delete-account', t.deleteAccount) },
    // Keeps this product signed in; only "Sign out" ends a session.
    { label: t.switchProduct, icon: 'swap-horizontal', onPress: () => void clearProduct() },
    {
      label: t.signOut,
      icon: 'log-out',
      danger: true,
      onPress: () =>
        Alert.alert(t.signOut, undefined, [
          { text: '✕', style: 'cancel' },
          { text: t.signOut, style: 'destructive', onPress: () => void signOut() },
        ]),
    },
  ];

  const Row = ({ icon, label, onPress, color }: { icon: string; label: string; onPress: () => void; color: string }) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: c.border, opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={20} color={color} />
      <Text style={[styles.rowText, { color: color === tint ? c.text : color }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={c.faint} />
    </Pressable>
  );

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.body}>
      <Text style={[styles.product, { color: c.text }]}>{product?.name}</Text>
      {!!user?.email && <Text style={[styles.muted, { color: c.muted }]}>{t.signedInAs.replace('{email}', user.email)}</Text>}

      {menu.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.muted }]}>{t.menu}</Text>
          {menu.map((item) => (
            <Row key={item.href} icon={menuIcon(item.key)} label={item.label} color={tint} onPress={() => open(item.href, item.label)} />
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: c.muted }]}>{t.accountSection}</Text>
        {account.map((row) => (
          <Row key={row.label} icon={row.icon} label={row.label} color={row.danger ? c.danger : tint} onPress={row.onPress} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, gap: 6 },
  product: { fontSize: 22, fontWeight: '800' },
  muted: { marginBottom: 4 },
  section: { marginTop: 16 },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, fontSize: 16 },
});
