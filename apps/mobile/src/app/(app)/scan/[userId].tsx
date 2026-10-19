import { useLocalSearchParams } from 'expo-router';

import { ScanScreen } from '@/screens/contact/scan';

export default function ScanRoute() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <ScanScreen userId={userId} />;
}
