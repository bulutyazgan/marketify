import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// Session-scoped cache of the last-known OS value. React Native has no synchronous
// `isReduceMotionEnabled` — without this cache every hook mount would flash `false`
// for the duration of the async query, briefly running full animations on devices
// where reduce-motion is on. First mount in the session still pays this cost; every
// mount after that reads the cached value synchronously.
let cached: boolean | null = null;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(cached ?? false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        cached = enabled;
        if (mounted) setReduced(enabled);
      })
      .catch(() => {
        if (mounted) setReduced(false);
      });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      cached = enabled;
      if (mounted) setReduced(enabled);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
