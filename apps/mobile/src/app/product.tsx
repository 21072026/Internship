import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { strings } from '../lib/i18n';
import { PRODUCTS } from '../lib/products';
import { useSession } from '../lib/session';
import { useAppTheme, type Palette } from '../lib/theme';

// First launch: pick the product. The choice decides the ONE host the app talks
// to (docs/worlds.md), so it comes before the sign-in form, as the URL does on
// the web.
export default function ProductScreen() {
  const { c } = useAppTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { chooseProduct } = useSession();
  const t = strings();

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          {t.pickTitle}
        </Text>
        {PRODUCTS.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            onPress={() => void chooseProduct(p.id)}
            style={({ pressed }) => [styles.card, { borderColor: p.color, opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.dot, { backgroundColor: p.color }]} />
            <Text style={styles.cardText}>{p.name}</Text>
          </Pressable>
        ))}
        <Text style={styles.hint}>{t.pickHint}</Text>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  body: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', color: c.text, marginBottom: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, borderRadius: 14, padding: 18 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  cardText: { fontSize: 18, fontWeight: '600', color: c.text },
  hint: { color: c.muted, textAlign: 'center', marginTop: 8 },
});
