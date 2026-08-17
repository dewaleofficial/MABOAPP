/**
 * src/navigation/RootNavigator.tsx
 * Identical mechanism to the customer app — real Supabase session drives
 * navigation, no hand-maintained isLoggedIn flag.
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
import { OrderListScreen } from '../screens/orders/OrderListScreen';
import { OrderDetailScreen } from '../screens/orders/OrderDetailScreen';

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
      <RootStack.Screen name="OrderList" component={OrderListScreen} options={{ title: 'My Orders', headerShown: false }} />
      <RootStack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
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
