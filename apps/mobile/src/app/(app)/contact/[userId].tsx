import { useLocalSearchParams } from 'expo-router';

import { ContactInfoScreen } from '@/screens/contact/contact-info';

export default function ContactRoute() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <ContactInfoScreen userId={userId} />;
}
