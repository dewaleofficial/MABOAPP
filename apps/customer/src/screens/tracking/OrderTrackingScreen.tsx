/**
 * src/screens/tracking/OrderTrackingScreen.tsx
 *
 * REAL: polls GET /orders/:id on the already-proven backend and renders
 * the actual milestoneKey/milestoneIndex/isComplete it returns. This is
 * live data — advance the order via the API elsewhere (or the partner
 * app, once built) and this screen reflects it on the next poll.
 *
 * NOT YET REAL, FLAGGED HONESTLY: this screen is meant to display the
 * handoff code when the current milestone requires one
 * (MilestoneSpec.requiresCode, e.g. 'identity' at courier_collected).
 * That requires a backend piece that does not exist anywhere yet — there
 * is no table storing generated codes, no endpoint generating one, and
 * OrderProjection (orders.service.ts:getOrderProjection) does not expose
 * whether the current milestone requires a code or what it is. Rather
 * than invent a fake code that would be meaningless, this screen shows an
 * honest "code pending" state when the milestone key matches a known
 * requiresCode milestone, and does nothing false otherwise.
 *
 * THE FIX: a handoff_codes table (or a column on orders) plus generation
 * logic in OrdersService.transition() when a code-requiring milestone is
 * reached, plus exposing it on GET /orders/:id for the milestone's actor.
 * This is real, scoped backend work — not something the mobile app can
 * work around on its own.
 */

import { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, RefreshControl, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { getOrder, ApiError, type OrderProjection } from '../../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderTracking'>;

// Milestone keys known to require a code, mirrored from the real service
// manifests (laundry.ts, courier.ts) purely for display purposes — see
// file header. This mirror can go stale exactly like the item-price
// mirrors in the builder screens; it drives UI text only, never a real
// security decision (the server enforces the actual requirement).
const CODE_MILESTONES: Record<string, string> = {
  rider_arrived: 'identity',
  bag_sealed: 'release',
  facility_received: 'facility',
  delivered: 'delivery',
  courier_collected: 'identity',
  courier_delivered: 'delivery',
};

const MILESTONE_LABELS: Record<string, string> = {
  placed: 'Order placed',
  rider_assigned: 'Rider assigned',
  rider_enroute: 'Rider on the way',
  rider_arrived: 'Rider has arrived',
  count_verified: 'Items verified',
  bag_sealed: 'Bag sealed',
  facility_received: 'Delivered to partner',
  facility_working: 'Being cleaned',
  facility_qa: 'Quality check',
  logistics_qa: 'Rider verifying',
  out_for_delivery: 'On the way back',
  delivered: 'Delivered',
  qa_window: '24-hour check window open',
  complete: 'Complete',
  courier_placed: 'Order placed',
  courier_rider_assigned: 'Rider assigned',
  courier_at_pickup: 'Rider at sender',
  courier_collected: 'Parcel collected',
  courier_at_dropoff: 'Rider at recipient',
  courier_delivered: 'Delivered',
  courier_qa_window: '24-hour check window open',
  courier_complete: 'Complete',
};

const POLL_INTERVAL_MS = 5000;

export function OrderTrackingScreen({ route }: Props) {
  const { orderId } = route.params;
  const [order, setOrder] = useState<OrderProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchOrder = useCallback(async () => {
    try {
      const result = await getOrder(orderId);
      setOrder(result);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(`Could not load order (${String(err.status)}).`);
      else setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [orderId]);

  useEffect(() => {
    fetchOrder();
    if (order?.isComplete) return;
    const interval = setInterval(fetchOrder, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // Intentionally re-subscribing whenever isComplete flips, so polling
    // stops the moment the order is done rather than running forever.
  }, [fetchOrder, order?.isComplete]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchOrder();
    setRefreshing(false);
  }

  if (!order && !error) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  const codeKind = order ? CODE_MILESTONES[order.milestoneKey] : undefined;
  const label = order ? (MILESTONE_LABELS[order.milestoneKey] ?? order.milestoneKey) : '';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {order ? (
        <>
          <View style={styles.statusCard}>
            <Text style={styles.statusBadge}>{order.isComplete ? 'COMPLETE' : 'IN PROGRESS'}</Text>
            <Text style={styles.milestoneLabel}>{label}</Text>
            <Text style={styles.milestoneMeta}>
              Step {order.milestoneIndex + 1} · {order.serviceId}
            </Text>
          </View>

          {codeKind ? (
            <View style={styles.codeCard}>
              <Text style={styles.codeTitle}>A {codeKind} code is needed at this step</Text>
              <Text style={styles.codePending}>
                Code display is not wired up yet — this requires a backend
                piece (code generation and storage) that doesn't exist yet.
                See this screen's file header for the exact gap.
              </Text>
            </View>
          ) : null}

          {!order.isComplete ? (
            <Text style={styles.pollHint}>Updates automatically every few seconds.</Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.md },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
  error: { color: theme.colors.danger, marginBottom: 12, fontSize: 13, textAlign: 'center' },
  statusCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' },
  statusBadge: { fontSize: 11, fontWeight: '700', color: theme.colors.primary, letterSpacing: 1, marginBottom: 8 },
  milestoneLabel: { fontSize: 22, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
  milestoneMeta: { fontSize: 12, color: theme.colors.textMuted, marginTop: 6 },
  codeCard: { backgroundColor: '#FFFBEB', borderRadius: 12, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.warning, marginTop: theme.spacing.md },
  codeTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.warning, marginBottom: 4 },
  codePending: { fontSize: 12, color: theme.colors.textMuted },
  pollHint: { fontSize: 11, color: theme.colors.textMuted, textAlign: 'center', marginTop: theme.spacing.md },
});
