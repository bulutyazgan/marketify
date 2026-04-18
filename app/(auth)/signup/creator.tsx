import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { ButtonPrimary } from '@/components/primitives/Button';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { useAuth, type AuthUser } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// US-034 — Creator signup. Username + at least one handle (TikTok and/or
// Instagram). Submit calls auth-signup-creator; the edge function holds the
// request open up to APIFY_WAIT_SECS (60s) while it dispatches scrapes, so
// the submitting state renders "Pulling your stats…" with skeleton cards for
// each supplied handle. On success the JWT + user row is handed to the
// AuthProvider and we jump to the creator tab group. Inline 409 handling
// mirrors the US-033 lister pattern; USERNAME_TAKEN pins to the username
// field, HANDLE_TAKEN falls through to a toast because the edge function
// does not say which platform conflicted.

type FieldKey = 'username' | 'tiktok' | 'instagram';
type FieldErrors = Partial<Record<FieldKey, string>>;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{1,30}$/;

type FieldValues = { username: string; tiktok: string; instagram: string };

function stripAt(value: string): string {
  return value.trim().replace(/^@+/, '').trim();
}

function clientValidate(v: FieldValues): FieldErrors {
  const errs: FieldErrors = {};
  const u = v.username.trim();
  const tt = stripAt(v.tiktok);
  const ig = stripAt(v.instagram);

  if (!u) errs.username = 'Username is required';
  else if (!USERNAME_RE.test(u)) errs.username = '3–32 letters, numbers, or underscores';

  if (tt && !HANDLE_RE.test(tt)) errs.tiktok = 'Letters, numbers, underscores, or dots';
  if (ig && !HANDLE_RE.test(ig)) errs.instagram = 'Letters, numbers, underscores, or dots';

  if (!tt && !ig) {
    const msg = 'Add at least one handle';
    errs.tiktok = msg;
    errs.instagram = msg;
  }

  return errs;
}

type SignupSuccess = {
  token: string;
  user_id: string;
  role: 'creator';
  metrics_status?: Record<string, unknown>;
};

export default function SignupCreator() {
  const router = useRouter();
  const { signIn } = useAuth();
  const { show: showToast } = useToast();

  const [username, setUsername] = useState('');
  const [tiktok, setTiktok] = useState('');
  const [instagram, setInstagram] = useState('');
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const clientErrors = useMemo(
    () => clientValidate({ username, tiktok, instagram }),
    [username, tiktok, instagram],
  );

  const visibleErrors: FieldErrors = {
    username: serverErrors.username ?? (touched.username ? clientErrors.username : undefined),
    tiktok: serverErrors.tiktok ?? (touched.tiktok ? clientErrors.tiktok : undefined),
    instagram:
      serverErrors.instagram ?? (touched.instagram ? clientErrors.instagram : undefined),
  };

  const markTouched = useCallback((key: FieldKey) => {
    setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  }, []);

  const updateField = useCallback(
    (key: FieldKey, setter: (s: string) => void) => (next: string) => {
      setter(next);
      setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    },
    [],
  );

  const onSubmit = useCallback(async () => {
    setTouched({ username: true, tiktok: true, instagram: true });
    const errs = clientValidate({ username, tiktok, instagram });
    if (Object.keys(errs).length > 0) return;

    const tiktokHandle = stripAt(tiktok);
    const instagramHandle = stripAt(instagram);

    setServerErrors({});
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke<SignupSuccess>(
        'auth-signup-creator',
        {
          body: {
            username: username.trim(),
            ...(tiktokHandle ? { tiktok_handle: tiktokHandle } : {}),
            ...(instagramHandle ? { instagram_handle: instagramHandle } : {}),
          },
        },
      );

      if (error) {
        const ctx = (error as { context?: unknown }).context;
        if (
          ctx &&
          typeof ctx === 'object' &&
          'status' in ctx &&
          typeof (ctx as { json?: unknown }).json === 'function'
        ) {
          const res = ctx as Response;
          let body: { error?: string } = {};
          try {
            body = (await res.json()) as { error?: string };
          } catch {
            // non-JSON body; fall through to generic toast
          }
          if (res.status === 409 && body.error === 'USERNAME_TAKEN') {
            setServerErrors({ username: 'Username already taken' });
            return;
          }
          if (res.status === 409 && body.error === 'HANDLE_TAKEN') {
            // Edge function does not identify which platform conflicted; the
            // creator profile screen (US-035) has the add/unlink flow that
            // can surface the specific collision.
            showToast({
              message: 'That handle is already linked to another account.',
              variant: 'error',
            });
            return;
          }
          if (res.status === 422 && body.error === 'HANDLE_REQUIRED') {
            const msg = 'Add at least one handle';
            setServerErrors({ tiktok: msg, instagram: msg });
            return;
          }
        }
        showToast({ message: 'Signup failed. Please try again.', variant: 'error' });
        return;
      }

      if (!data) {
        showToast({ message: 'Signup failed. Please try again.', variant: 'error' });
        return;
      }

      const nowIso = new Date().toISOString();
      const nextUser: AuthUser = {
        id: data.user_id,
        username: username.trim(),
        email: null,
        role: 'creator',
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      };
      signIn(data.token, nextUser);
      showToast({ message: 'Welcome', variant: 'success' });
      router.replace('/(creator)/feed');
    } catch (err) {
      console.error('Creator signup threw', err);
      showToast({ message: 'Signup failed. Please try again.', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [username, tiktok, instagram, signIn, showToast, router]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(auth)');
  }, [router]);

  if (submitting) {
    return <PullingStatsState tiktok={stripAt(tiktok)} instagram={stripAt(instagram)} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={onBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back to role picker"
            testID="creator-signup-back"
            style={styles.backBtn}
          >
            <ChevronLeft size={24} color={colors.ink} />
          </Pressable>

          <View style={styles.header}>
            <Text style={[textStyles.display, styles.title]}>Creator signup</Text>
            <Text style={[textStyles.body, styles.subtitle]}>
              Pick a username and add at least one handle — we&apos;ll pull your stats.
            </Text>
          </View>

          <View style={styles.fields}>
            <Field
              label="Username"
              value={username}
              onChange={updateField('username', setUsername)}
              onBlur={() => markTouched('username')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              placeholder="sarah_films"
              error={visibleErrors.username}
              testID="creator-signup-username"
            />
            <Field
              label="TikTok handle"
              value={tiktok}
              onChange={updateField('tiktok', setTiktok)}
              onBlur={() => markTouched('tiktok')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="default"
              placeholder="@sarahfilms"
              mono
              error={visibleErrors.tiktok}
              testID="creator-signup-tiktok"
            />
            <Field
              label="Instagram handle"
              value={instagram}
              onChange={updateField('instagram', setInstagram)}
              onBlur={() => markTouched('instagram')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="default"
              placeholder="@sarahfilms"
              mono
              error={visibleErrors.instagram}
              testID="creator-signup-instagram"
            />
          </View>

          <ButtonPrimary
            label="Continue"
            onPress={onSubmit}
            loading={submitting}
            disabled={submitting}
            accessibilityLabel="Continue creator signup"
            testID="creator-signup-submit"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function PullingStatsState({
  tiktok,
  instagram,
}: {
  tiktok: string;
  instagram: string;
}) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.loadingContent}>
        <View
          style={styles.header}
          accessible
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Pulling your stats. This can take up to a minute while we fetch your public profile."
        >
          <Text style={[textStyles.display, styles.title]}>Pulling your stats…</Text>
          <Text style={[textStyles.body, styles.subtitle]}>
            This can take up to a minute while we fetch your public profile.
          </Text>
        </View>
        <View style={styles.skeletons}>
          {tiktok ? (
            <SkeletonCard height={96} testID="creator-signup-skeleton-tiktok" />
          ) : null}
          {instagram ? (
            <SkeletonCard height={96} testID="creator-signup-skeleton-instagram" />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  autoComplete?: TextInputProps['autoComplete'];
  keyboardType?: TextInputProps['keyboardType'];
  placeholder?: string;
  error?: string;
  mono?: boolean;
  testID?: string;
};

function Field({
  label,
  value,
  onChange,
  onBlur,
  autoCapitalize,
  autoCorrect,
  autoComplete,
  keyboardType,
  placeholder,
  error,
  mono,
  testID,
}: FieldProps) {
  const hasError = !!error;
  return (
    <View style={styles.field}>
      <Text style={[textStyles.caption, styles.label]}>{label}</Text>
      <View style={[styles.inputWrap, shadows.hard, hasError && styles.inputWrapError]}>
        <TextInput
          value={value}
          onChangeText={onChange}
          onBlur={onBlur}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          autoComplete={autoComplete}
          keyboardType={keyboardType}
          placeholder={placeholder}
          placeholderTextColor={colors.ink40}
          style={[mono ? textStyles.mono : textStyles.body, styles.input]}
          accessibilityLabel={label}
          testID={testID}
        />
      </View>
      <Text
        style={[textStyles.caption, styles.errorText, !hasError && styles.errorHidden]}
        accessibilityLiveRegion="polite"
        importantForAccessibility={hasError ? 'yes' : 'no-hide-descendants'}
      >
        {error ?? ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  flex: { flex: 1 },
  scrollContent: {
    padding: spacing.base,
    gap: spacing.xl,
  },
  loadingContent: {
    flex: 1,
    padding: spacing.base,
    gap: spacing.xl,
    paddingTop: spacing.xxl,
  },
  header: {
    gap: spacing.sm,
    paddingTop: spacing.base,
  },
  backBtn: {
    alignSelf: 'flex-start',
    padding: spacing.xs,
    marginLeft: -spacing.xs,
  },
  title: { color: colors.ink },
  subtitle: { color: colors.ink70 },
  fields: { gap: spacing.base },
  field: { gap: spacing.xs },
  label: { color: colors.ink70 },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  inputWrapError: {
    borderColor: colors.danger,
  },
  input: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 48,
  },
  errorText: {
    color: colors.danger,
  },
  errorHidden: {
    height: 0,
    opacity: 0,
    overflow: 'hidden',
  },
  skeletons: {
    gap: spacing.md,
  },
});
