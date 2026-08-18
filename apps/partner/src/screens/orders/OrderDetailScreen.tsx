/**
 * src/screens/orders/OrderDetailScreen.tsx
 *
 * The core of the partner app. Two real action paths:
 *
 *   1. A plain transition (no code needed) — calls transitionOrder(),
 *      the same proven endpoint the customer app's mocked-payment screen
 *      uses. No milestone-advancement logic lives client-side; the server
 *      decides what's legal.
 *
 *   2. A code-requiring milestone — the partner enters what the customer
 *      or facility told them, calls verifyHandoffCode(). This screen
 *      reads response.status directly rather than a generic error
 *      message, because the three real outcomes (409 wrong-but-retryable,
 *      423 locked out, 404 no active code) need genuinely different UI,
 *      not the same "something went wrong" banner.
 *
 * CODE_REQUIRED_MILESTONES mirrors the real service manifests
 * (laundry.ts, courier.ts) for DISPLAY purposes only — same documented
 * mirror-not-source-of-truth seam as the customer app's builder screens.
 * The server is the only place that actually decides whether a code is
 * required; this mirror only decides whether to show the code-entry UI.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { getOrder, transitionOrder, verifyHandoffCode, ApiError, type OrderProjection } from '../../api/client';
import type { HandoffCodeKind, OrderEventType } from '@provia/types';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderDetail'>;

// Mirrors the real ADVANCING_EVENT map in packages/core/src/engine/
// stateMachine.ts, restricted to events a PARTNER (not the system, not
// the customer) actually triggers. Courier and laundry share this
// display map because their milestone keys never collide (proven by a
// real test last night).
const NEXT_ACTION: Record<
  string,
  { label: string; type: OrderEventType; requiresCode?: HandoffCodeKind }
> = {
  rider_assigned: { label: 'Mark en route', type: 'rider.assigned' },
  rider_enroute: { label: "I've arrived", type: 'rider.arrived' },
  rider_arrived: { label: 'Enter customer code', type: 'code.accepted', requiresCode: 'identity' },
  count_verified: { label: 'Seal bag', type: 'bag.sealed' },
  bag_sealed: { label: 'Enter release code', type: 'facility.received', requiresCode: 'release' },
  facility_received: { label: 'Enter facility code', type: 'facility.qa_passed', requiresCode: 'facility' },
  facility_working: { label: 'Mark QA passed', type: 'facility.qa_passed' },
  facility_qa: { label: 'Rider: mark collected', type: 'logistics.qa_passed' },
  logistics_qa: { label: 'Out for delivery', type: 'order.delivered' },
  out_for_delivery: { label: "I've arrived", type: 'order.delivered' },
  delivered: { label: 'Enter delivery code', type: 'qa_window.opened', requiresCode: 'delivery' },
  courier_rider_assigned: { label: 'Mark en route to sender', type: 'rider.assigned' },
  courier_at_pickup: { label: "I've arrived", type: 'rider.arrived' },
  courier_collected: { label: 'Enter sender code', type: 'code.accepted', requiresCode: 'identity' },
  courier_at_dropoff: { label: "I've arrived at recipient", type: 'rider.arrived' },
  courier_delivered: { label: 'Enter recipient code', type: 'order.delivered', requiresCode: 'delivery' },
};

const MILESTONE_LABELS: Record<string, string> = {
  placed: 'Awaiting payment',
  rider_assigned: 'Rider assigned',
  rider_enroute: 'Rider on the way',
  rider_arrived: 'Rider at customer',
  count_verified: 'Items verified',
  bag_sealed: 'Sealed',
  facility_received: 'At facility',
  facility_working: 'Being cleaned',
  facility_qa: 'Facility QA passed',
  logistics_qa: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  delivered: 'At customer',
  qa_window: '24h window open',
  complete: 'Complete',
  courier_placed: 'Awaiting payment',
  courier_rider_assigned: 'Rider assigned',
  courier_at_pickup: 'At sender',
  courier_collected: 'Collected',
  courier_at_dropoff: 'At recipient',
  courier_delivered: 'Delivered',
  courier_qa_window: '24h window open',
  courier_complete: 'Complete',
};

export function OrderDetailScreen({ route }: Props) {
  const { orderId } = route.params;
  const [order, setOrder] = useState<OrderProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeErrorKind, setCodeErrorKind] = useState<'retryable' | 'locked' | 'none' | null>(null);

  const load = useCallback(async () => {
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
    load();
  }, [load]);

  const action = order ? NEXT_ACTION[order.milestoneKey] : undefined;

  async function handlePlainAction() {
    if (!action) return;
    setActionLoading(true);
    setError(null);
    try {
      await transitionOrder(orderId, action.type);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(`Action failed (${String(err.status)}).`);
      else setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleVerifyCode() {
    if (!action?.requiresCode) return;
    setCodeError(null);
    setCodeErrorKind(null);
    if (codeInput.trim().length !== 4) {
      setCodeError('Enter the 4-digit code.');
      return;
    }

    setActionLoading(true);
    try {
      await verifyHandoffCode(orderId, action.requiresCode, codeInput.trim());
      setCodeInput('');
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        // The three real, distinct outcomes proven tonight — each gets
        // its own message and its own UI state, not a shared banner.
        if (err.status === 409) {
          setCodeErrorKind('retryable');
          setCodeError('Wrong code. Try again.');
        } else if (err.status === 423) {
          setCodeErrorKind('locked');
          setCodeError('This order is locked after 3 failed attempts. Contact support — this needs review before it can continue.');
        } else if (err.status === 404) {
          setCodeErrorKind('none');
          setCodeError('No active code for this step. Refresh and try again.');
        } else {
          setCodeError(`Could not verify (${String(err.status)}).`);
        }
      } else {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setActionLoading(false);
    }
  }

  if (!order && !error) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {order ? (
        <>
          <View style={styles.statusCard}>
            <Text style={styles.statusBadge}>{order.isComplete ? 'COMPLETE' : order.serviceId.toUpperCase()}</Text>
            <Text style={styles.milestoneLabel}>
              {MILESTONE_LABELS[order.milestoneKey] ?? order.milestoneKey}
            </Text>
            <Text style={styles.milestoneMeta}>Step {order.milestoneIndex + 1}</Text>
          </View>

          {action && !order.isComplete ? (
            action.requiresCode ? (
              <View style={styles.actionCard}>
                <Text style={styles.actionLabel}>{action.label}</Text>
                <TextInput
                  style={styles.codeInput}
                  placeholder="0000"
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={4}
                  value={codeInput}
                  onChangeText={setCodeInput}
                  editable={!actionLoading && codeErrorKind !== 'locked'}
                />
                {codeError ? (
                  <Text style={[styles.codeError, codeErrorKind === 'locked' && styles.codeErrorLocked]}>
                    {codeError}
                  </Text>
                ) : null}
                <Pressable
                  style={[styles.actionButton, (actionLoading || codeErrorKind === 'locked') && styles.actionButtonDisabled]}
                  onPress={handleVerifyCode}
                  disabled={actionLoading || codeErrorKind === 'locked'}
                >
                  {actionLoading ? (
                    <ActivityIndicator color={theme.colors.onPrimary} />
                  ) : (
                    <Text style={styles.actionButtonText}>Verify code</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={[styles.actionButton, actionLoading && styles.actionButtonDisabled]}
                onPress={handlePlainAction}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator color={theme.colors.onPrimary} />
                ) : (
                  <Text style={styles.actionButtonText}>{action.label}</Text>
                )}
              </Pressable>
            )
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
  statusCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  statusBadge: { fontSize: 11, fontWeight: '700', color: theme.colors.primary, letterSpacing: 1, marginBottom: 8 },
  milestoneLabel: { fontSize: 20, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
  milestoneMeta: { fontSize: 12, color: theme.colors.textMuted, marginTop: 6 },
  actionCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionLabel: { fontSize: 14, fontWeight: '600', color: theme.colors.text, marginBottom: theme.spacing.sm },
  codeInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    padding: 14,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    color: theme.colors.text,
    marginBottom: 10,
  },
  codeError: { color: theme.colors.danger, fontSize: 12, marginBottom: 10, textAlign: 'center' },
  codeErrorLocked: { color: theme.colors.danger, fontWeight: '700' },
  actionButton: { backgroundColor: theme.colors.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
  actionButtonDisabled: { opacity: 0.5 },
  actionButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
