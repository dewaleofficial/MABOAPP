/**
 * src/screens/orders/OrderListScreen.tsx
 *
 * Calls the real GET /orders endpoint (apps/api/src/orders/orders.
 * controller.ts) — proven tonight against real Postgres to correctly
 * scope to the logged-in partner via their verified JWT, and to correctly
 * return nothing for an unrelated partner. There is no client-side
 * filtering happening here; the list this screen renders is exactly what
 * the server decided belongs to this partner.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { listMyOrders, ApiError, type OrderProjection } from '../../api/client';
import { supabase } from '../../lib/supabase';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderList'>;

const MILESTONE_LABELS: Record<string, string> = {
  placed: 'Awaiting payment',
  rider_assigned: 'Rider assigned',
  rider_enroute: 'Rider on the way',
  rider_arrived: 'Rider at customer — code needed',
  count_verified: 'Items verified',
  bag_sealed: 'Sealed — heading to facility',
  facility_received: 'At facility',
  facility_working: 'Being cleaned',
  facility_qa: 'Facility QA passed',
  logistics_qa: 'Rider collecting from facility',
  out_for_delivery: 'Out for delivery',
  delivered: 'At customer — code needed',
  qa_window: 'Delivered, 24h window open',
  complete: 'Complete',
  courier_placed: 'Awaiting payment',
  courier_rider_assigned: 'Rider assigned',
  courier_at_pickup: 'At sender',
  courier_collected: 'Collected — code needed',
  courier_at_dropoff: 'At recipient — code needed',
  courier_delivered: 'Delivered',
  courier_qa_window: '24h window open',
  courier_complete: 'Complete',
};

export function OrderListScreen({ navigation }: Props) {
  const [orders, setOrders] = useState<readonly OrderProjection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await listMyOrders();
      setOrders(result);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(`Could not load orders (${String(err.status)}).`);
      else setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!orders && !error) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>My orders</Text>
        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={orders ?? []}
        keyExtractor={(item) => item.orderId}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !error ? <Text style={styles.empty}>No orders assigned to you yet.</Text> : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => navigation.navigate('OrderDetail', { orderId: item.orderId })}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardService}>{item.serviceId}</Text>
              {item.isComplete ? <Text style={styles.completeBadge}>COMPLETE</Text> : null}
            </View>
            <Text style={styles.cardMilestone}>
              {MILESTONE_LABELS[item.milestoneKey] ?? item.milestoneKey}
            </Text>
            <Text style={styles.cardMeta}>Order {item.orderId.slice(0, 8)}…</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing.md,
    paddingTop: theme.spacing.xl,
  },
  title: { fontSize: 24, fontWeight: '700', color: theme.colors.text },
  signOut: { color: theme.colors.textMuted, fontSize: 13 },
  error: { color: theme.colors.danger, fontSize: 13, textAlign: 'center', marginBottom: theme.spacing.sm },
  empty: { color: theme.colors.textMuted, textAlign: 'center', marginTop: theme.spacing.xl, fontSize: 14 },
  listContent: { padding: theme.spacing.md, paddingTop: 0 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardService: { fontSize: 12, fontWeight: '700', color: theme.colors.primary, textTransform: 'uppercase' },
  completeBadge: { fontSize: 10, fontWeight: '700', color: theme.colors.success },
  cardMilestone: { fontSize: 15, fontWeight: '600', color: theme.colors.text, marginTop: 6 },
  cardMeta: { fontSize: 11, color: theme.colors.textMuted, marginTop: 4 },
});
