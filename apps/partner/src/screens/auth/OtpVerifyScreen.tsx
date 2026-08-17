/**
 * src/screens/auth/OtpVerifyScreen.tsx
 * Identical mechanism to the customer app — verifyOtp() creates the real
 * Supabase session, RootNavigator switches on it automatically.
 */

import { useState, useRef } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../../lib/supabase';
import { theme } from '../../theme';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParamList, 'OtpVerify'>;

export function OtpVerifyScreen({ route }: Props) {
  const { phone } = route.params;
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const inputRef = useRef<TextInput>(null);

  async function handleVerify() {
    setError(null);
    if (code.trim().length < 4) {
      setError('Enter the code you received by SMS.');
      return;
    }
    setLoading(true);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone,
      token: code.trim(),
      type: 'sms',
    });
    setLoading(false);
    if (verifyError) setError(verifyError.message);
  }

  async function handleResend() {
    setError(null);
    setResending(true);
    const { error: resendError } = await supabase.auth.signInWithOtp({ phone });
    setResending(false);
    if (resendError) setError(resendError.message);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter the code</Text>
      <Text style={styles.subtitle}>We sent a code to {phone}.</Text>

      <TextInput
        ref={inputRef}
        style={styles.input}
        placeholder="000000"
        placeholderTextColor={theme.colors.textMuted}
        keyboardType="number-pad"
        autoComplete="sms-otp"
        maxLength={6}
        value={code}
        onChangeText={setCode}
        editable={!loading}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleVerify}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={theme.colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Verify</Text>
        )}
      </Pressable>

      <Pressable onPress={handleResend} disabled={resending} style={styles.resendButton}>
        <Text style={styles.resendText}>{resending ? 'Sending…' : "Didn't get a code? Resend"}</Text>
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
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
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
  resendButton: { marginTop: 20, alignItems: 'center' },
  resendText: { color: theme.colors.primary, fontSize: 14 },
});
