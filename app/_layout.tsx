import { useEffect } from 'react';
import { Slot } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { fontAssets } from '@/design/typography';
import { ToastProvider } from '@/components/primitives/Toast';

// Hold the splash screen until custom fonts register — text with an unregistered
// fontFamily silently falls back to System on iOS and the swap is visible to the user.
// Promise rejects if the splash was already dismissed (fast-refresh, dev reloads) —
// swallow so Metro doesn't see an unhandled rejection.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ToastProvider>
        <Slot />
      </ToastProvider>
      <StatusBar style="auto" />
    </GestureHandlerRootView>
  );
}
