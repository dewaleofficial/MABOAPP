/**
 * src/screens/tracking/MockPaymentScreen.tsx
 *
 * "Mocked" refers to the money — there is no Paystack call here, per the
 * founder's decision recorded in this session (no live payments until a
 * registered business account exists). Everything else is real: this
 * screen calls the real transitionOrder('order.paid') against the real,
 * already-proven backend, which runs the real state machine and appends
 * a real order_events row. From the state machine's point of view, this
 * is indistinguishable from a genuine Paystack webhook confirming
 * payment — see orders.controller.ts and paystack.controller.ts, which
 * both ultimately call the same OrdersService.transition().
 */

import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { transitionOrder, ApiError } from '../../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'MockPayment'>;

export function MockPaymentScreen({ route, navigation }: Props) {
  const { orderId, serviceLabel } = route.params;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setLoading(true);
    try {
      // The real transition call — advances the real state machine from
      // "placed" to "rider_assigned" exactly as a genuine payment would.
      await transitionOrder(orderId, 'order.paid');
      navigation.replace('OrderTracking', { orderId });
    } catch (err) {
      if (err instanceof ApiError) setError(`Payment could not be confirmed (${String(err.status)}).`);
      else setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Pay for</Text>
        <Text style={styles.serviceLabel}>{serviceLabel}</Text>
        <Text style={styles.pilotNote}>
          Pilot mode — no real payment is taken. Confirming this advances your order exactly as a real payment would.
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.confirmButton, loading && styles.confirmButtonDisabled]} onPress={handleConfirm} disabled={loading}>
        {loading ? <ActivityIndicator color={theme.colors.onPrimary} /> : <Text style={styles.confirmButtonText}>Confirm payment</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.md, justifyContent: 'center' },
  card: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.colors.border, marginBottom: theme.spacing.lg, alignItems: 'center' },
  label: { fontSize: 12, color: theme.colors.textMuted },
  serviceLabel: { fontSize: 22, fontWeight: '700', color: theme.colors.text, marginTop: 4, marginBottom: 16 },
  pilotNote: { fontSize: 12, color: theme.colors.warning, textAlign: 'center' },
  error: { color: theme.colors.danger, marginBottom: 12, fontSize: 13, textAlign: 'center' },
  confirmButton: { backgroundColor: theme.colors.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
  confirmButtonDisabled: { opacity: 0.6 },
  confirmButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
