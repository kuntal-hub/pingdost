import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { GroupPictureError, groupPictureUri, pickGroupPicture } from '@/engine/groups';
import { useChatRuntime } from '@/engine/hooks';
import { ApiError } from '@pingdost/api-client';
import { GROUP_NAME_MAX } from '@pingdost/message-engine';

import { MemberPicker } from './member-picker';

function createError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'GROUP_FULL') return 'That is more people than a group can have.';
    if (error.kind !== 'http') return 'You seem to be offline. Connect and try again.';
  }
  return 'The group could not be created. Try again.';
}

/** Name, optional picture and members; this user becomes the group's owner. */
export function NewGroupScreen() {
  const router = useRouter();
  const runtime = useChatRuntime();
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<Uint8Array | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function choosePicture() {
    try {
      const bytes = await pickGroupPicture();
      if (bytes) setPicture(bytes);
    } catch (caught) {
      setError(caught instanceof GroupPictureError ? caught.message : 'That picture did not work.');
    }
  }

  async function create() {
    if (!runtime) return;
    setError(undefined);
    if (name.trim() === '') {
      setError('Give the group a name.');
      return;
    }
    if (members.length === 0) {
      setError('Pick at least one person.');
      return;
    }
    setBusy(true);
    try {
      const conversation = await runtime.engine.createGroup({
        name,
        avatar: picture,
        memberUserIds: members,
      });
      router.replace({
        pathname: '/chat/[conversationId]',
        params: { conversationId: conversation.conversationId },
      });
    } catch (caught) {
      setError(createError(caught));
      setBusy(false);
    }
  }

  return (
    <Screen offlineBanner>
      <View className="flex-row items-center gap-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={picture ? 'Change group picture' : 'Add group picture'}
          onPress={() => void choosePicture()}
          className="active:opacity-70"
        >
          <Avatar url={groupPictureUri(picture)} name={name || '+'} size={64} />
        </Pressable>
        <View className="flex-1">
          <TextField
            label="Group name"
            value={name}
            onChangeText={setName}
            maxLength={GROUP_NAME_MAX}
            returnKeyType="next"
          />
        </View>
      </View>
      <Text className="text-muted">
        The name and picture are end-to-end encrypted: only members see them. The server knows only
        who is in the group, to deliver messages.
      </Text>
      <Text accessibilityRole="header" className="font-semibold text-foreground">
        Members{members.length > 0 ? ` (${members.length})` : ''}
      </Text>
      <MemberPicker selected={members} onChange={setMembers} />
      {error && <Notice tone="error" message={error} />}
      <Button label="Create group" loading={busy} onPress={() => void create()} />
    </Screen>
  );
}
