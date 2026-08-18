import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { injectDevSessionIfConfigured } from './devSessionInjector';

export default function App() {
  // DEV/TESTING ONLY — see devSessionInjector.ts's own header comment.
  // Inert (does nothing) unless app.json's extra block has
  // devInjectAccessToken/devInjectRefreshToken explicitly set.
  useEffect(() => {
    injectDevSessionIfConfigured();
  }, []);

  return (
    <SafeAreaProvider>
      <RootNavigator />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

