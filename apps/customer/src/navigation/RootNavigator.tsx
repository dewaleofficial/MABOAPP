/**
 * src/navigation/RootNavigator.tsx
 *
 * Listens to Supabase's real onAuthStateChange — the same event that
 * fires the moment OtpVerifyScreen's verifyOtp() call succeeds. There is
 * no separate "isLoggedIn" flag maintained by hand anywhere in this app;
 * the session object from Supabase IS the source of truth, matching the
 * backend's own principle of deriving state rather than tracking it
 * redundantly (CLAUDE.md §7, §10 — applied here to client state, not just
 * order state, for the same reason: two sources of truth drift apart).
 */

import { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { Session } from '@supabase/supabase-js';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from '../lib/supabase';
import { theme } from '../theme';
import type { AuthStackParamList, RootStackParamList } from './types';

import { PhoneEntryScreen } from '../screens/auth/PhoneEntryScreen';
import { OtpVerifyScreen } from '../screens/auth/OtpVerifyScreen';
import { HomeScreen } from '../screens/home/HomeScreen';
import { LaundryBuilderScreen } from '../screens/laundry/LaundryBuilderScreen';
import { LaundryReviewScreen } from '../screens/laundry/LaundryReviewScreen';
import { CourierBuilderScreen } from '../screens/courier/CourierBuilderScreen';
import { CourierReviewScreen } from '../screens/courier/CourierReviewScreen';
import { MockPaymentScreen } from '../screens/tracking/MockPaymentScreen';
import { OrderTrackingScreen } from '../screens/tracking/OrderTrackingScreen';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
      <AuthStack.Screen name="OtpVerify" component={OtpVerifyScreen} />
    </AuthStack.Navigator>
  );
}

function MainNavigator() {
  return (
    <RootStack.Navigator screenOptions={{ headerTintColor: theme.colors.primary }}>
      <RootStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <RootStack.Screen name="LaundryBuilder" component={LaundryBuilderScreen} options={{ title: 'Build your order' }} />
      <RootStack.Screen name="LaundryReview" component={LaundryReviewScreen} options={{ title: 'Review order' }} />
      <RootStack.Screen name="CourierBuilder" component={CourierBuilderScreen} options={{ title: 'Send a parcel' }} />
      <RootStack.Screen name="CourierReview" component={CourierReviewScreen} options={{ title: 'Review delivery' }} />
      <RootStack.Screen name="MockPayment" component={MockPaymentScreen} options={{ title: 'Payment', headerBackVisible: false }} />
      <RootStack.Screen name="OrderTracking" component={OrderTrackingScreen} options={{ title: 'Track order' }} />
    </RootStack.Navigator>
  );
}

export function RootNavigator() {
  const [session, setSession] = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitialising(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  if (initialising) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {session ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
});
