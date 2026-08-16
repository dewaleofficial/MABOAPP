/**
 * src/screens/laundry/LaundryReviewScreen.tsx
 *
 * "Place order" here does NOT call transitionOrder — an order does not
 * exist on the backend yet at this point (there is no POST /orders
 * endpoint built for the pilot; orders are created directly via the
 * database in this pilot's scope, same as how orders were seeded for
 * yesterday's attack-suite verification). This screen therefore calls a
 * placeOrder() helper that is explicitly a pilot-scope stand-in — see its
 * own file for exactly what it does and does not do. This is flagged
 * here, not hidden, because it is a real, deliberate scope boundary.
 */

import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { placeOrderPilotStub } from '../../api/placeOrderPilotStub';

type Props = NativeStackScreenProps<RootStackParamList, 'LaundryReview'>;

export function LaundryReviewScreen({ route, navigation }: Props) {
  const { groups } = route.params;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalItems = groups.reduce(
    (sum, g) => sum + Object.values(g.items).reduce((a, b) => a + b, 0),
    0,
  );

  async function handlePay() {
    setError(null);
    setLoading(true);
    try {
      const { orderId } = await placeOrderPilotStub('laundry', { groups });
      navigation.replace('MockPayment', { orderId, amount: 0, serviceLabel: 'Laundry' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place order.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {groups.map((g, i) => (
          <View key={i}>
            <Text style={styles.groupTitle}>Group {i + 1} — {g.categoryKey}</Text>
            {Object.entries(g.items).map(([key, qty]) => (
              <Text key={key} style={styles.itemLine}>{key} × {qty}</Text>
            ))}
            <Text style={styles.detailLine}>{g.treatmentKey} · {g.qualityKey}</Text>
          </View>
        ))}
        <Text style={styles.totalLine}>{totalItems} items total</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.payButton, loading && styles.payButtonDisabled]} onPress={handlePay} disabled={loading}>
        {loading ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.payButtonText}>Confirm order</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.md },
  card: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, marginBottom: theme.spacing.md },
  groupTitle: { fontSize: 14, fontWeight: '600', color: theme.colors.text, marginBottom: 6 },
  itemLine: { fontSize: 13, color: theme.colors.textMuted, marginLeft: 8 },
  detailLine: { fontSize: 12, color: theme.colors.textMuted, marginTop: 4, marginLeft: 8, fontStyle: 'italic' },
  totalLine: { fontSize: 13, fontWeight: '600', color: theme.colors.text, marginTop: 12 },
  error: { color: theme.colors.danger, marginBottom: 12, fontSize: 13, textAlign: 'center' },
  payButton: { backgroundColor: theme.colors.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
  payButtonDisabled: { opacity: 0.6 },
  payButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
