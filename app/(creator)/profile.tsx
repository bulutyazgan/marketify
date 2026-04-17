import { View } from 'react-native';
import { ButtonSecondary } from '@/components/primitives/Button';
import { TabPlaceholder } from '@/components/shared/TabPlaceholder';
import { spacing } from '@/design/tokens';
import { useAuth } from '@/lib/auth';

// US-035 replaces the placeholder with handles + metrics + add/unlink flows.
// Sign-out is exposed here so dev testers can flip back to /(auth) without
// reinstalling Expo Go; US-037 lifts a canonical sign-out into the lister
// profile (design applies the same button to both roles).
export default function CreatorProfile() {
  const { signOut } = useAuth();
  return (
    <TabPlaceholder
      title="Profile"
      subtitle="Handles + metrics + add/unlink flows land in US-035."
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.xl }}>
        <ButtonSecondary
          label="Sign out"
          onPress={signOut}
          accessibilityLabel="Sign out"
          testID="creator-signout"
        />
      </View>
    </TabPlaceholder>
  );
}
