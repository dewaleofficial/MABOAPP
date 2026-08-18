/**
 * src/devSessionInjector.ts
 *
 * ============================================================
 * DEV/TESTING ONLY — NOT PRODUCTION CODE. SAFE BY DEFAULT.
 * ============================================================
 *
 * Real Termii SMS delivery is blocked on CAC business registration (see
 * the project's gap tracker). This lets the app open already
 * authenticated for local UI walkthroughs, without touching
 * PhoneEntryScreen, OtpVerifyScreen, or RootNavigator at all — those stay
 * exactly as they'll work once real SMS is wired up.
 *
 * How it works: Supabase's own supabase.auth.setSession({access_token,
 * refresh_token}) is a real, public, documented client method for
 * establishing a session from tokens obtained elsewhere (e.g. a
 * server-side or Admin API sign-in) — not a hack or an internal API. It
 * writes to the same storage adapter and fires the same
 * onAuthStateChange event a real OTP verification would, so
 * RootNavigator behaves identically either way.
 *
 * INERT BY DEFAULT: this does nothing unless app.json's extra block has
 * devInjectAccessToken and devInjectRefreshToken set. No production or
 * real-pilot build should ever have those keys present — remove this
 * file and its one call site in App.tsx once real SMS delivery works, or
 * at minimum confirm those extra keys are absent before any build that
 * isn't purely local testing.
 */

import Constants from 'expo-constants';
import { supabase } from './src/lib/supabase';

export async function injectDevSessionIfConfigured(): Promise<void> {
  const accessToken = Constants.expoConfig?.extra?.['devInjectAccessToken'] as string | undefined;
  const refreshToken = Constants.expoConfig?.extra?.['devInjectRefreshToken'] as string | undefined;

  if (!accessToken || !refreshToken) return; // the normal, expected case — nothing happens

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    // Fail loudly rather than silently leaving the app on the auth
    // screen with no explanation — this only ever runs during a
    // deliberate local test, so a visible console error is the right
    // amount of noise, not a production concern.
    // eslint-disable-next-line no-console
    console.error('[devSessionInjector] Failed to inject session:', error.message);
  }
}
