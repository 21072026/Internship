import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { strings } from '../../lib/i18n';
import { useSession } from '../../lib/session';

export default function MoreTab() {
  const { user, product, signOut, clearProduct } = useSession();
  const t = strings();

  const rows: { label: string; onPress: () => void; danger?: boolean }[] = [
    { label: t.account, onPress: () => router.push({ pathname: '/web', params: { path: '/account', title: t.account } }) },
    {
      label: t.deleteAccount,
      onPress: () => router.push({ pathname: '/web', params: { path: '/delete-account', title: t.deleteAccount } }),
    },
    {
      label: t.switchProduct,
      onPress: async () => {
        await signOut();
        await clearProduct();
      },
    },
    {
      label: t.signOut,
      danger: true,
      onPress: () =>
        Alert.alert(t.signOut, undefined, [
          { text: '✕', style: 'cancel' },
          { text: t.signOut, style: 'destructive', onPress: () => void signOut() },
        ]),
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.product}>{product?.name}</Text>
      {!!user?.email && <Text style={styles.muted}>{t.signedInAs.replace('{email}', user.email)}</Text>}
      {rows.map((row) => (
        <Pressable
          key={row.label}
          accessibilityRole="button"
          onPress={row.onPress}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.rowText, row.danger && styles.danger]}>{row.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, gap: 6 },
  product: { fontSize: 22, fontWeight: '800', color: '#111827' },
  muted: { color: '#6b7280', marginBottom: 12 },
  row: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  rowText: { fontSize: 16, color: '#111827' },
  danger: { color: '#b91c1c' },
});
