import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { X } from 'lucide-react-native';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { SPRING_SNAPPY, withReducedMotion } from '@/design/motion';
import { useReducedMotion } from '@/design/useReducedMotion';
import { textStyles } from '@/design/typography';

// Global toast banner per docs/design.md §6 inventory (`message, variant, duration`)
// and §1.4 line 439 ("2.5s success toast"). Mount ToastProvider once near the root
// (app/_layout.tsx) and call useToast().show({...}) from anywhere.
//
// Variants drive the soft-bg + border color from the semantic palette in §1.2.
// Progress bar counts down the remaining duration so the user can gauge when it
// will auto-dismiss.

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastPayload = {
  message: string;
  variant?: ToastVariant;
  duration?: number; // ms, default 2500
};

type ToastContextValue = {
  show: (t: ToastPayload) => void;
  hide: () => void;
};

const DEFAULT_DURATION = 2500;

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}

type InternalToast = {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<InternalToast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const show = useCallback(
    (t: ToastPayload) => {
      clearTimer();
      const id = Date.now();
      const duration = t.duration ?? DEFAULT_DURATION;
      setToast({
        id,
        message: t.message,
        variant: t.variant ?? 'info',
        duration,
      });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Only clear if this toast still owns the slot (show() may have replaced it).
        setToast((cur) => (cur?.id === id ? null : cur));
      }, duration);
    },
    [clearTimer],
  );

  useEffect(() => () => clearTimer(), [clearTimer]);

  const value = useMemo<ToastContextValue>(() => ({ show, hide }), [show, hide]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? <ToastSurface toast={toast} onDismiss={hide} /> : null}
    </ToastContext.Provider>
  );
}

type VariantPalette = { bg: string; border: string };

const VARIANT_PALETTE: Record<ToastVariant, VariantPalette> = {
  success: { bg: colors.successSoft, border: colors.success },
  error: { bg: colors.dangerSoft, border: colors.danger },
  info: { bg: colors.primarySoft, border: colors.primary },
};

type ToastSurfaceProps = {
  toast: InternalToast;
  onDismiss: () => void;
};

function ToastSurface({ toast, onDismiss }: ToastSurfaceProps) {
  const reduced = useReducedMotion();
  const translateY = useSharedValue(-140);
  const progress = useSharedValue(1);
  const trackWidth = useSharedValue(0);

  useEffect(() => {
    // Reset each time a new toast replaces the slot (toast.id changes) so the
    // enter spring + progress countdown replay from their start positions.
    translateY.value = -140;
    translateY.value = withSpring(
      0,
      withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced),
    );
    progress.value = 1;
    if (!reduced) {
      progress.value = withTiming(0, {
        duration: toast.duration,
        easing: Easing.linear,
      });
    }
    return () => {
      cancelAnimation(translateY);
      cancelAnimation(progress);
    };
  }, [toast.id, toast.duration, reduced, translateY, progress]);

  const handleTrackLayout = (event: LayoutChangeEvent) => {
    trackWidth.value = event.nativeEvent.layout.width;
  };

  const bannerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const progressFillStyle = useAnimatedStyle(() => ({
    width: trackWidth.value * progress.value,
  }));

  const palette = VARIANT_PALETTE[toast.variant];

  return (
    <SafeAreaView pointerEvents="box-none" style={styles.root}>
      <Animated.View
        pointerEvents="auto"
        style={[
          styles.banner,
          { backgroundColor: palette.bg, borderColor: palette.border },
          shadows.hard,
          bannerStyle,
        ]}
        accessibilityRole="alert"
      >
        <View style={styles.row}>
          <Text
            style={[textStyles.body, styles.message, { color: colors.ink }]}
            numberOfLines={3}
            allowFontScaling={false}
          >
            {toast.message}
          </Text>
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notification"
            hitSlop={8}
          >
            <X size={18} color={colors.ink} strokeWidth={2.5} />
          </Pressable>
        </View>
        <View
          style={[styles.progressTrack, { backgroundColor: colors.surface }]}
          onLayout={handleTrackLayout}
        >
          <Animated.View
            style={[styles.progressFill, { backgroundColor: palette.border }, progressFillStyle]}
          />
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
  banner: {
    marginTop: spacing.sm,
    width: '92%',
    maxWidth: 520,
    borderRadius: radii.card,
    borderWidth: 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.base,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  message: {
    flex: 1,
  },
  progressTrack: {
    marginTop: spacing.sm,
    height: 3,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.pill,
  },
});
