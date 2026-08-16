/**
 * src/screens/laundry/LaundryBuilderScreen.tsx
 *
 * The category/item data below is a client-side MIRROR of
 * packages/core/src/services/laundry.ts — it must be kept in sync with
 * that file manually, since a mobile app cannot import server-only
 * TypeScript. This is a real, known seam, not an oversight: the source of
 * truth for pricing stays server-side (CLAUDE.md §3.9 — the server never
 * trusts a client-supplied price), so this screen's prices are for
 * DISPLAY ONLY. The actual charge is computed fresh by computePrice() on
 * the backend from the order composition this screen submits — if this
 * mirror ever drifts from laundry.ts, the customer sees a slightly wrong
 * estimate here but is never charged the wrong amount, because the
 * server recomputes independently.
 *
 * A future improvement is a generated types/catalogue endpoint so this
 * mirror is fetched, not hand-copied — flagged here rather than silently
 * left as a maintenance trap.
 */

import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LaundryGroupDraft, RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'LaundryBuilder'>;

// Mirrors laundry.ts's `categories` — see file header for why this is a
// deliberate, documented duplication rather than an import.
const CATEGORIES = [
  { key: 'men', label: 'Men', emoji: '👔', items: [
    { key: 'shirt', label: 'Shirt', emoji: '👔', priceNaira: 400 },
    { key: 'trouser', label: 'Trouser', emoji: '👖', priceNaira: 450 },
    { key: 'blazer', label: 'Blazer', emoji: '🧥', priceNaira: 800 },
    { key: 'agbada', label: 'Agbada', emoji: '👘', priceNaira: 1500 },
  ]},
  { key: 'women', label: 'Women', emoji: '👗', items: [
    { key: 'blouse', label: 'Blouse', emoji: '👚', priceNaira: 400 },
    { key: 'dress', label: 'Dress', emoji: '👗', priceNaira: 700 },
    { key: 'iro_buba', label: 'Iro & Buba', emoji: '👘', priceNaira: 1400 },
  ]},
  { key: 'children', label: 'Children', emoji: '🧒', items: [
    { key: 'kids_top', label: 'Kids top', emoji: '👕', priceNaira: 250 },
    { key: 'uniform', label: 'School uniform', emoji: '🎒', priceNaira: 400 },
  ]},
  { key: 'bedding', label: 'Bedding', emoji: '🛏️', items: [
    { key: 'bed_sheet', label: 'Bed sheet', emoji: '🛏️', priceNaira: 700 },
    { key: 'duvet', label: 'Duvet', emoji: '🛌', priceNaira: 1800 },
  ]},
];

const TREATMENTS = [
  { key: 'wash_only', label: 'Wash only' },
  { key: 'wash_iron', label: 'Wash + Iron' },
  { key: 'dry_clean', label: 'Dry clean' },
];
const QUALITIES = [
  { key: 'regular', label: 'Regular' },
  { key: 'standard', label: 'Standard' },
  { key: 'premium', label: 'Premium' },
];

const MINIMUM_ORDER_NAIRA = 3000; // mirrors laundry.ts's minimumOrderValue

export function LaundryBuilderScreen({ navigation }: Props) {
  const [categoryKey, setCategoryKey] = useState(CATEGORIES[0]!.key);
  const [items, setItems] = useState<Record<string, number>>({});
  const [treatmentKey, setTreatmentKey] = useState(TREATMENTS[0]!.key);
  const [qualityKey, setQualityKey] = useState(QUALITIES[0]!.key);

  const category = CATEGORIES.find((c) => c.key === categoryKey)!;

  function changeQty(itemKey: string, delta: number) {
    setItems((prev) => {
      const next = Math.max(0, (prev[itemKey] ?? 0) + delta);
      const copy = { ...prev };
      if (next === 0) delete copy[itemKey];
      else copy[itemKey] = next;
      return copy;
    });
  }

  const estimateNaira = Object.entries(items).reduce((sum, [key, qty]) => {
    const item = category.items.find((i) => i.key === key);
    return sum + (item ? item.priceNaira * qty : 0);
  }, 0);

  const meetsMinimum = estimateNaira >= MINIMUM_ORDER_NAIRA;

  function handleContinue() {
    if (Object.keys(items).length === 0) return;
    const group: LaundryGroupDraft = { categoryKey, items, treatmentKey, qualityKey };
    navigation.navigate('LaundryReview', { groups: [group] });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionLabel}>CATEGORY</Text>
      <View style={styles.chipRow}>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            style={[styles.chip, categoryKey === c.key && styles.chipSelected]}
            onPress={() => setCategoryKey(c.key)}
          >
            <Text style={styles.chipEmoji}>{c.emoji}</Text>
            <Text style={[styles.chipLabel, categoryKey === c.key && styles.chipLabelSelected]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionLabel}>ITEMS</Text>
      {category.items.map((item) => {
        const qty = items[item.key] ?? 0;
        return (
          <View key={item.key} style={styles.itemRow}>
            <Text style={styles.itemEmoji}>{item.emoji}</Text>
            <View style={styles.itemInfo}>
              <Text style={styles.itemLabel}>{item.label}</Text>
              <Text style={styles.itemPrice}>₦{item.priceNaira} each</Text>
            </View>
            <View style={styles.stepper}>
              <Pressable style={styles.stepperButton} onPress={() => changeQty(item.key, -1)}>
                <Text style={styles.stepperButtonText}>−</Text>
              </Pressable>
              <Text style={styles.stepperValue}>{qty}</Text>
              <Pressable style={styles.stepperButton} onPress={() => changeQty(item.key, 1)}>
                <Text style={styles.stepperButtonText}>+</Text>
              </Pressable>
            </View>
          </View>
        );
      })}

      <Text style={styles.sectionLabel}>TREATMENT</Text>
      <View style={styles.chipRow}>
        {TREATMENTS.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.chip, treatmentKey === t.key && styles.chipSelected]}
            onPress={() => setTreatmentKey(t.key)}
          >
            <Text style={[styles.chipLabel, treatmentKey === t.key && styles.chipLabelSelected]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionLabel}>QUALITY</Text>
      <View style={styles.chipRow}>
        {QUALITIES.map((q) => (
          <Pressable
            key={q.key}
            style={[styles.chip, qualityKey === q.key && styles.chipSelected]}
            onPress={() => setQualityKey(q.key)}
          >
            <Text style={[styles.chipLabel, qualityKey === q.key && styles.chipLabelSelected]}>{q.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.footer}>
        <View>
          <Text style={styles.footerLabel}>Estimate</Text>
          <Text style={styles.footerValue}>₦{estimateNaira.toLocaleString()}</Text>
          {!meetsMinimum && estimateNaira > 0 ? (
            <Text style={styles.footerHint}>Minimum order is ₦{MINIMUM_ORDER_NAIRA.toLocaleString()}</Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.continueButton, !meetsMinimum && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!meetsMinimum}
        >
          <Text style={styles.continueButtonText}>Continue</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.md, paddingBottom: 120 },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: theme.colors.textMuted, letterSpacing: 1, marginTop: theme.spacing.lg, marginBottom: theme.spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  chip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' },
  chipSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surface },
  chipEmoji: { fontSize: 18 },
  chipLabel: { fontSize: 13, color: theme.colors.textMuted, marginTop: 2 },
  chipLabelSelected: { color: theme.colors.text, fontWeight: '600' },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  itemEmoji: { fontSize: 20, marginRight: theme.spacing.sm },
  itemInfo: { flex: 1 },
  itemLabel: { fontSize: 14, color: theme.colors.text },
  itemPrice: { fontSize: 11, color: theme.colors.textMuted },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { fontSize: 16, color: theme.colors.text },
  stepperValue: { fontSize: 15, fontWeight: '600', minWidth: 18, textAlign: 'center' },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.background, borderTopWidth: 1, borderTopColor: theme.colors.border, padding: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLabel: { fontSize: 11, color: theme.colors.textMuted },
  footerValue: { fontSize: 20, fontWeight: '700', color: theme.colors.text },
  footerHint: { fontSize: 10, color: theme.colors.warning, marginTop: 2 },
  continueButton: { backgroundColor: theme.colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  continueButtonDisabled: { opacity: 0.4 },
  continueButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
