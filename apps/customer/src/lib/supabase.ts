/**
 * src/lib/supabase.ts
 *
 * CLAUDE.md §9 — the anon key is safe to ship in this client ONLY because
 * RLS is correct on every table (proven in infra/migrations/
 * 0001_foundation.sql, CI-guarded by scripts/check-rls.mjs). This client
 * never uses the service_role key — that key must never appear in a
 * mobile app.
 */

import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

function requireExtra(key: string): string {
  const value = Constants.expoConfig?.extra?.[key] as string | undefined;
  if (!value) {
    throw new Error(
      `Missing app config value: ${key}. Set it in app.json's "extra" block or via an EAS secret.`,
    );
  }
  return value;
}

/**
 * Supabase's JS client expects a storage adapter with get/set/remove.
 * SecureStore is the correct choice on native (Keychain on iOS, Keystore
 * on Android) — an auth session is exactly the kind of value that
 * shouldn't sit in plain AsyncStorage.
 */
const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(
  requireExtra('supabaseUrl'),
  requireExtra('supabaseAnonKey'),
  {
    auth: {
      storage: secureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
