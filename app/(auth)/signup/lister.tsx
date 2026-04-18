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
import { useToast } from '@/components/primitives/Toast';
import { useAuth, type AuthUser } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// US-033 — Lister (Company) signup. Three fields → auth-signup-lister edge
// function; 409 USERNAME_TAKEN / EMAIL_TAKEN surface inline on the conflicting
// field, other errors fall through to a toast. Design: docs/design.md §2.1
// Company Profile (captures username + email + org name; website_url is
// optional per the edge-function contract and deferred out of v1's core signup
// to keep the form to the story AC's three fields).

type FieldKey = 'username' | 'email' | 'orgName';
type FieldErrors = Partial<Record<FieldKey, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

type FieldValues = { username: string; email: string; orgName: string };

function clientValidate(v: FieldValues): FieldErrors {
  const errs: FieldErrors = {};
  const u = v.username.trim();
  const e = v.email.trim();
  const o = v.orgName.trim();
  if (!u) errs.username = 'Username is required';
  else if (!USERNAME_RE.test(u)) errs.username = '3–32 letters, numbers, or underscores';
  if (!e) errs.email = 'Email is required';
  else if (!EMAIL_RE.test(e)) errs.email = 'Enter a valid email';
  if (!o) errs.orgName = 'Company name is required';
  return errs;
}

type SignupSuccess = { token: string; user_id: string; role: 'lister' };

export default function SignupLister() {
  const router = useRouter();
  const { signIn } = useAuth();
  const { show: showToast } = useToast();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const clientErrors = useMemo(
    () => clientValidate({ username, email, orgName }),
    [username, email, orgName],
  );

  // Server-originated inline errors always win; client errors only surface once
  // the user has touched a field (avoids yelling before they've typed anything).
  const visibleErrors: FieldErrors = {
    username: serverErrors.username ?? (touched.username ? clientErrors.username : undefined),
    email: serverErrors.email ?? (touched.email ? clientErrors.email : undefined),
    orgName: serverErrors.orgName ?? (touched.orgName ? clientErrors.orgName : undefined),
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
    setTouched({ username: true, email: true, orgName: true });
    const errs = clientValidate({ username, email, orgName });
    if (Object.keys(errs).length > 0) return;

    setServerErrors({});
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke<SignupSuccess>(
        'auth-signup-lister',
        {
          body: {
            username: username.trim(),
            email: email.trim(),
            org_name: orgName.trim(),
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
            // supabase-js v2 does not pre-read the error Response, so reading
            // directly is safe; `.clone()` would just add a second stream-state
            // failure surface without any benefit here.
            body = (await res.json()) as { error?: string };
          } catch {
            // non-JSON body; fall through to generic toast
          }
          if (res.status === 409 && body.error === 'USERNAME_TAKEN') {
            setServerErrors({ username: 'Username already taken' });
            return;
          }
          if (res.status === 409 && body.error === 'EMAIL_TAKEN') {
            setServerErrors({ email: 'Email already in use' });
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

      // The edge function response carries only token + user_id + role. We
      // construct the AuthUser row shape client-side; the real timestamps live
      // in Postgres and will be read by later queries (profile screen, etc.).
      const nowIso = new Date().toISOString();
      const nextUser: AuthUser = {
        id: data.user_id,
        username: username.trim(),
        email: email.trim(),
        role: 'lister',
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      };
      signIn(data.token, nextUser);
      showToast({ message: 'Welcome', variant: 'success' });
      router.replace('/(lister)/dashboard');
    } catch (err) {
      console.error('Lister signup threw', err);
      showToast({ message: 'Signup failed. Please try again.', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [username, email, orgName, signIn, showToast, router]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(auth)');
  }, [router]);

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
            testID="lister-signup-back"
            style={styles.backBtn}
          >
            <ChevronLeft size={24} color={colors.ink} />
          </Pressable>

          <View style={styles.header}>
            <Text style={[textStyles.display, styles.title]}>Company signup</Text>
            <Text style={[textStyles.body, styles.subtitle]}>
              Pick a handle, tell us who you are, and start posting bounties.
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
              placeholder="acme_media"
              error={visibleErrors.username}
              testID="lister-signup-username"
            />
            <Field
              label="Email"
              value={email}
              onChange={updateField('email', setEmail)}
              onBlur={() => markTouched('email')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              placeholder="hello@acme.co"
              error={visibleErrors.email}
              testID="lister-signup-email"
            />
            <Field
              label="Company name"
              value={orgName}
              onChange={updateField('orgName', setOrgName)}
              onBlur={() => markTouched('orgName')}
              autoCapitalize="words"
              autoComplete="organization"
              placeholder="Acme Media"
              error={visibleErrors.orgName}
              testID="lister-signup-orgname"
            />
          </View>

          <ButtonPrimary
            label="Finish"
            onPress={onSubmit}
            loading={submitting}
            disabled={submitting}
            accessibilityLabel="Finish company signup"
            testID="lister-signup-submit"
          />
        </ScrollView>
      </KeyboardAvoidingView>
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
          style={[textStyles.body, styles.input]}
          accessibilityLabel={label}
          testID={testID}
        />
      </View>
      {/* Always mounted so `accessibilityLiveRegion` can announce content
          changes on Android — a node that mounts alongside its first content
          does not reliably fire an announcement there. */}
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
});
