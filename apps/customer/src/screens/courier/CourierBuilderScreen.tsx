/**
 * src/screens/courier/CourierBuilderScreen.tsx
 * Mirrors packages/core/src/services/courier.ts's parcel tiers — same
 * documented-duplication seam as LaundryBuilderScreen. See that file's
 * header for the full rationale; not repeated here.
 */

import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'CourierBuilder'>;

// Mirrors courier.ts's parcel tiers exactly.
const TIERS = [
  { key: 'documents', label: 'Documents', emoji: '📄', priceNaira: 1500 },
  { key: 'small', label: 'Small parcel', emoji: '📦', priceNaira: 2500 },
  { key: 'medium', label: 'Medium parcel', emoji: '📦', priceNaira: 4500 },
  { key: 'large_bulky', label: 'Large / bulky', emoji: '🛋️', priceNaira: 9000 },
];

export function CourierBuilderScreen({ navigation }: Props) {
  const [tierKey, setTierKey] = useState(TIERS[0]!.key);
  const [pickupAddress, setPickupAddress] = useState('');
  const [dropoffAddress, setDropoffAddress] = useState('');

  const canContinue = pickupAddress.trim().length > 3 && dropoffAddress.trim().length > 3;
  const tier = TIERS.find((t) => t.key === tierKey)!;

  function handleContinue() {
    if (!canContinue) return;
    navigation.navigate('CourierReview', {
      parcels: { [tierKey]: 1 },
      pickupAddress: pickupAddress.trim(),
      dropoffAddress: dropoffAddress.trim(),
    });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionLabel}>COLLECT FROM</Text>
      <TextInput
        style={styles.input}
        placeholder="Pickup address"
        placeholderTextColor={theme.colors.textMuted}
        value={pickupAddress}
        onChangeText={setPickupAddress}
      />

      <Text style={styles.sectionLabel}>DELIVER TO</Text>
      <TextInput
        style={styles.input}
        placeholder="Recipient address"
        placeholderTextColor={theme.colors.textMuted}
        value={dropoffAddress}
        onChangeText={setDropoffAddress}
      />

      <Text style={styles.sectionLabel}>WHAT ARE YOU SENDING?</Text>
      {TIERS.map((t) => (
        <Pressable
          key={t.key}
          style={[styles.tierRow, tierKey === t.key && styles.tierRowSelected]}
          onPress={() => setTierKey(t.key)}
        >
          <Text style={styles.tierEmoji}>{t.emoji}</Text>
          <Text style={styles.tierLabel}>{t.label}</Text>
          <Text style={styles.tierPrice}>₦{t.priceNaira.toLocaleString()}</Text>
        </Pressable>
      ))}

      <View style={styles.footer}>
        <View>
          <Text style={styles.footerLabel}>Estimate</Text>
          <Text style={styles.footerValue}>₦{tier.priceNaira.toLocaleString()}</Text>
        </View>
        <Pressable
          style={[styles.continueButton, !canContinue && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!canContinue}
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
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 14, fontSize: 14, color: theme.colors.text },
  tierRow: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  tierRowSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surface },
  tierEmoji: { fontSize: 20, marginRight: 12 },
  tierLabel: { flex: 1, fontSize: 14, color: theme.colors.text },
  tierPrice: { fontSize: 13, fontWeight: '600', color: theme.colors.text },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.background, borderTopWidth: 1, borderTopColor: theme.colors.border, padding: theme.spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLabel: { fontSize: 11, color: theme.colors.textMuted },
  footerValue: { fontSize: 20, fontWeight: '700', color: theme.colors.text },
  continueButton: { backgroundColor: theme.colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  continueButtonDisabled: { opacity: 0.4 },
  continueButtonText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: 15 },
});
