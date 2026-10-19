import { useLocalSearchParams } from 'expo-router';

import { ReportScreen } from '@/screens/contact/report';

export default function ReportRoute() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <ReportScreen userId={userId} />;
}
