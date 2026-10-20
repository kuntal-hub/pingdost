import { useLocalSearchParams } from 'expo-router';

import { GroupInfoScreen } from '@/screens/groups/group-info';

export default function GroupInfoRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return <GroupInfoScreen groupId={groupId} />;
}
