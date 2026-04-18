import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// Campaign-creation wizard state (US-049 through US-053). React-context + AsyncStorage
// persistence — not MMKV, because `react-native-mmkv` v4 is a Nitro module that
// cannot load in Expo Go (see Codebase Pattern #105, progress.txt). AsyncStorage
// satisfies the AC's "wizard store + MMKV" intent with a transport that actually
// boots in Expo Go. The wizard draft is not secret material, so AsyncStorage (vs
// expo-secure-store) is the correct fit.
//
// Shape covers all five steps up front so later stories (US-050 pre-conditions,
// US-051 post-conditions, US-052 samples + max, US-053 publish) can read and
// write their slices without a store rewrite. Step 1 (this story) only wires the
// first four fields; the rest are kept with empty-array / null defaults.

export type WizardCurrency = 'USD' | 'EUR' | 'GBP';

export type WizardPreConditionPlatform = 'tiktok' | 'instagram';
export type WizardPreConditionMetric = 'followers' | 'avg_views';

export type WizardPreCondition = {
  id: string;
  platform: WizardPreConditionPlatform;
  metric: WizardPreConditionMetric;
  threshold: number;
};

export type WizardPostCondition = {
  id: string;
  text: string;
};

export type WizardDraft = {
  title: string;
  description: string;
  priceCents: number | null;
  currency: WizardCurrency;
  preConditions: WizardPreCondition[];
  postConditions: WizardPostCondition[];
  sampleUrls: string[];
  maxSubmissions: number | null;
};

const EMPTY_DRAFT: WizardDraft = {
  title: '',
  description: '',
  priceCents: null,
  currency: 'USD',
  preConditions: [],
  postConditions: [],
  sampleUrls: [],
  maxSubmissions: null,
};

const STORAGE_KEY = '@marketify/campaign-wizard-draft/v1';
const PERSIST_DEBOUNCE_MS = 250;

type WizardContextValue = {
  draft: WizardDraft;
  hydrated: boolean;
  setField: <K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => void;
  setPartial: (patch: Partial<WizardDraft>) => void;
  resetDraft: () => Promise<void>;
};

const WizardContext = createContext<WizardContextValue | null>(null);

function isWizardDraftShape(value: unknown): value is WizardDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === 'string' &&
    typeof v.description === 'string' &&
    (v.priceCents === null || typeof v.priceCents === 'number') &&
    (v.currency === 'USD' || v.currency === 'EUR' || v.currency === 'GBP') &&
    Array.isArray(v.preConditions) &&
    Array.isArray(v.postConditions) &&
    Array.isArray(v.sampleUrls) &&
    (v.maxSubmissions === null || typeof v.maxSubmissions === 'number')
  );
}

export function WizardProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_DRAFT);
  const [hydrated, setHydrated] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror the latest draft so the unmount cleanup can flush whatever is
  // pending without closure-capture of stale state.
  const draftRef = useRef<WizardDraft>(draft);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (isWizardDraftShape(parsed)) {
            setDraft(parsed);
          }
        }
      } catch {
        // Corrupted / missing draft — start clean. No user-visible error:
        // the wizard is a local-first flow and an empty draft is the right
        // fallback.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const schedulePersist = useCallback((next: WizardDraft) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        // Flush pending edit before cancelling. AsyncStorage.setItem is
        // async and fire-and-forget here — React unmount paths don't await
        // promises, but kicking the write off before clearing the timer is
        // what prevents the last keystroke from being dropped if the
        // provider unmounts inside the 250 ms debounce window.
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(draftRef.current));
      }
    };
  }, []);

  const setField = useCallback(
    <K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => {
      setDraft((prev) => {
        const next = { ...prev, [key]: value };
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  const setPartial = useCallback(
    (patch: Partial<WizardDraft>) => {
      setDraft((prev) => {
        const next = { ...prev, ...patch };
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  const resetDraft = useCallback(async () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    setDraft(EMPTY_DRAFT);
    await AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  const value = useMemo<WizardContextValue>(
    () => ({ draft, hydrated, setField, setPartial, resetDraft }),
    [draft, hydrated, setField, setPartial, resetDraft],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext);
  if (!ctx) {
    throw new Error('useWizard must be used inside <WizardProvider>');
  }
  return ctx;
}
