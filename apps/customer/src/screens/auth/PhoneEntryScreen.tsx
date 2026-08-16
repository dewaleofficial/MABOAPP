/**
 * src/screens/auth/PhoneEntryScreen.tsx
 *
 * Step 1 of sign-in. Calls Supabase's real signInWithOtp — this actually
 * sends an SMS via whatever provider Supabase's project is configured
 * with (Twilio, MessageBird, etc.), which must be set up server-side in
 * the Supabase dashboard for this to work end to end; this screen makes
 * the real call regardless, it does not simulate anything.
 */

import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../../lib/supabase';
import { theme } from '../../theme';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParamList, 'PhoneEntry'>;

/** Very light shape check — real validation (country code rules etc.) is
 *  a later concern; this exists only to stop an obviously-empty submit. */
function looksLikePhoneNumber(value: string): boolean {
  return /^\+?[0-9]{10,15}$/.test(value.replace(/[\s-]/g, ''));
}

export function PhoneEntryScreen({ navigation }: Props) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    const normalised = phone.replace(/[\s-]/g, '');
    if (!looksLikePhoneNumber(normalised)) {
      setError('Enter a valid phone number, including country code.');
      return;
    }

    setLoading(true);
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: normalised });
    setLoading(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }

    navigation.navigate('OtpVerify', { phone: normalised });
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to Provia</Text>
      <Text style={styles.subtitle}>Enter your phone number to get started.</Text>

      <TextInput
        style={styles.input}
        placeholder="+234 800 000 0000"
        placeholderTextColor={theme.colors.textMuted}
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
        editable={!loading}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleContinue}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={theme.colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Continue</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', color: theme.colors.text, marginBottom: 8 },
  subtitle: { fontSize: 15, color: theme.colors.textMuted, marginBottom: 32 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: theme.colors.text,
    marginBottom: 12,
  },
  error: { color: theme.colors.danger, marginBottom: 12, fontSize: 13 },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: theme.colors.onPrimary, fontSize: 16, fontWeight: '600' },
});
