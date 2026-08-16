/**
 * src/screens/home/HomeScreen.tsx
 * Pilot scope: exactly two services, matching the two service modules
 * that exist and are proven on the backend (laundry, courier). Adding a
 * third service module later means adding one more card here — this
 * screen does not hardcode assumptions beyond that list.
 */

import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { theme } from '../../theme';
import { supabase } from '../../lib/supabase';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const SERVICES = [
  { id: 'laundry', emoji: '🧺', label: 'Laundry', description: 'Wash, iron, dry clean', screen: 'LaundryBuilder' as const },
  { id: 'courier', emoji: '📦', label: 'Courier', description: 'Same-day parcel delivery', screen: 'CourierBuilder' as const },
];

export function HomeScreen({ navigation }: Props) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.greeting}>What do you need?</Text>
        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.grid}>
        {SERVICES.map((service) => (
          <Pressable
            key={service.id}
            style={styles.card}
            onPress={() => navigation.navigate(service.screen)}
          >
            <Text style={styles.cardEmoji}>{service.emoji}</Text>
            <Text style={styles.cardLabel}>{service.label}</Text>
            <Text style={styles.cardDescription}>{service.description}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, paddingTop: theme.spacing.xl },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.spacing.lg },
  greeting: { fontSize: 26, fontWeight: '700', color: theme.colors.text },
  signOut: { color: theme.colors.textMuted, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
  card: {
    width: '47%',
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardEmoji: { fontSize: 32, marginBottom: theme.spacing.sm },
  cardLabel: { fontSize: 16, fontWeight: '600', color: theme.colors.text },
  cardDescription: { fontSize: 12, color: theme.colors.textMuted, marginTop: 4 },
});
