import { View } from 'react-native';
import { ButtonSecondary } from '@/components/primitives/Button';
import { TabPlaceholder } from '@/components/shared/TabPlaceholder';
import { spacing } from '@/design/tokens';
import { useAuth } from '@/lib/auth';

// US-037 replaces the placeholder with org name + email + canonical sign-out.
export default function ListerProfile() {
  const { signOut } = useAuth();
  return (
    <TabPlaceholder title="Profile" subtitle="Org + email + sign-out land in US-037.">
      <View style={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.xl }}>
        <ButtonSecondary
          label="Sign out"
          onPress={signOut}
          accessibilityLabel="Sign out"
          testID="lister-signout"
        />
      </View>
    </TabPlaceholder>
  );
}
