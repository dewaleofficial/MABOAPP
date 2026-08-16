/**
 * src/screens/courier/CourierReviewScreen.tsx
 * Same placeOrderPilotStub pattern as LaundryReviewScreen — see that
 * file and placeOrderPilotStub.ts for the real, flagged pricing gap.
 */

import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { placeOrderPilotStub } from '../../api/placeOrderPilotStub';

type Props = NativeStackScreenProps<RootStackParamList, 'CourierReview'>;

export function CourierReviewScreen({ route, navigation }: Props) {
  const { parcels, pickupAddress, dropoffAddress } = route.params;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay() {
    setError(null);
    setLoading(true);
    try {
      const { orderId } = await placeOrderPilotStub('courier', { parcels, pickupAddress, dropoffAddress });
      navigation.replace('MockPayment', { orderId, amount: 0, serviceLabel: 'Courier' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place order.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.rowLabel}>From</Text>
        <Text style={styles.rowValue}>{pickupAddress}</Text>
        <Text style={[styles.rowLabel, { marginTop: 12 }]}>To</Text>
        <Text style={styles.rowValue}>{dropoffAddress}</Text>
        <Text style={[styles.rowLabel, { marginTop: 12 }]}>Parcel</Text>
        {Object.entries(parcels).map(([key, qty]) => (
          <Text key={key} style={styles.rowValue}>{key} × {qty}</Text>
        ))}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.payButton, loading && styles.payButtonDisabled]} onPress={handlePay} disabled={loading}>
        {loading ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.payButtonText}>Confirm delivery</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.md },
  card: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, marginBottom: theme.spacing.md },
  rowLabel: { fontSize: 11, color: theme.colors.textMuted, fontWeight: '600' },
  rowValue: { fontSize: 14, color: theme.colors.text, marginTop: 2 },
  error: { color: theme.colors.danger, marginBottom: 12, fontSize: 13, textAlign: 'center' },
  payButton: { backgroundColor: theme.colors.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
  payButtonDisabled: { opacity: 0.6 },
  payButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
