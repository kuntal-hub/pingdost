import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useGroup } from '@/engine/groups';
import { useChatRuntime } from '@/engine/hooks';
import { ApiError } from '@pingdost/api-client';

import { MemberPicker } from './member-picker';

/** Admins add people; they can read only what is sent after they join. */
export function AddMembersScreen({ groupId }: { groupId: string }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const group = useGroup(groupId);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!runtime || selected.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await runtime.engine.addGroupMembers(groupId, selected);
      router.back();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'GROUP_FULL'
          ? 'The group is full.'
          : 'They could not be added. Try again.',
      );
      setBusy(false);
    }
  }

  return (
    <Screen offlineBanner>
      <Text className="text-muted">
        New members see messages from when they join; earlier ones stay unreadable to them.
      </Text>
      <MemberPicker
        selected={selected}
        onChange={setSelected}
        exclude={group?.members.map((m) => m.userId) ?? []}
      />
      {error && <Notice tone="error" message={error} />}
      <Button
        label={selected.length > 1 ? `Add ${selected.length} people` : 'Add'}
        disabled={selected.length === 0}
        loading={busy}
        onPress={() => void add()}
      />
    </Screen>
  );
}
