import { Redirect } from 'expo-router';
import { PrimitivesPreview } from '@/screens/_dev/PrimitivesPreview';

export default function PrimitivesRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <PrimitivesPreview />;
}
