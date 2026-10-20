import { useLocalSearchParams } from 'expo-router';

import { AddMembersScreen } from '@/screens/groups/add-members';

export default function AddMembersRoute() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return <AddMembersScreen groupId={groupId} />;
}
