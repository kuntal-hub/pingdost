import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { contactName } from '@/engine/contacts';
import { GroupPictureError, groupPictureUri, pickGroupPicture, useGroup } from '@/engine/groups';
import { useChatRuntime, useContact } from '@/engine/hooks';
import { usePalette } from '@/theme/theme-root';
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  isAdmin,
  MUTED_FOREVER,
  roleOf,
  type ConversationRecord,
  type GroupMemberRecord,
  type GroupRole,
} from '@pingdost/message-engine';

const ROLE_LABEL: Record<GroupRole, string> = { owner: 'Owner', admin: 'Admin', member: '' };

function failed(action: string): void {
  Alert.alert(`Could not ${action}`, 'Check your connection and try again.');
}

function MemberRow({
  member,
  self,
  onPress,
}: {
  member: GroupMemberRecord;
  self: boolean;
  onPress: () => void;
}) {
  const contact = useContact(member.userId);
  const name = self ? 'You' : contactName(contact);
  const role = ROLE_LABEL[member.role];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${role ? `, ${role}` : ''}`}
      disabled={self}
      onPress={onPress}
      className="min-h-[56px] flex-row items-center gap-3 px-4 py-2 active:opacity-70"
    >
      <Avatar url={contact?.avatarUrl} name={name} size={40} />
      <Text className="flex-1 text-base text-foreground">{name}</Text>
      {role !== '' && <Text className="text-muted">{role}</Text>}
    </Pressable>
  );
}

/** Members and roles, the E2EE name and picture, mute, add/remove, leave. No calls (REQ §8.2). */
export function GroupInfoScreen({ groupId }: { groupId: string }) {
  const router = useRouter();
  const palette = usePalette();
  const runtime = useChatRuntime();
  const group = useGroup(groupId);
  const [conversation, setConversation] = useState<ConversationRecord>();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picture, setPicture] = useState<Uint8Array | null>(null);
  const [chosen, setChosen] = useState<GroupMemberRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selfUserId = runtime?.userId ?? '';

  useEffect(() => {
    if (!runtime) return;
    const load = () => void runtime.engine.getConversation(groupId).then(setConversation);
    load();
    return runtime.engine.onConversationListChanged(load);
  }, [runtime, groupId]);

  if (!runtime || !group) {
    return (
      <Screen>
        <Notice message={group === undefined ? 'Loading…' : 'This group is not on this phone.'} />
      </Screen>
    );
  }
  const { engine } = runtime;
  const myRole = group.left ? undefined : roleOf(group, selfUserId);
  const admin = isAdmin(myRole);
  const muted = conversation?.mutedUntil != null && conversation.mutedUntil > Date.now();

  function startEditing() {
    if (!group) return;
    setName(group.name);
    setDescription(group.description);
    setPicture(group.avatar);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await engine.updateGroupInfo(groupId, { name, description, avatar: picture });
      setEditing(false);
    } catch {
      setError('The changes could not be saved. Check the name and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function choosePicture() {
    try {
      const bytes = await pickGroupPicture();
      if (bytes) setPicture(bytes);
    } catch (caught) {
      setError(caught instanceof GroupPictureError ? caught.message : 'That picture did not work.');
    }
  }

  function leave() {
    Alert.alert(
      'Leave this group?',
      'You stop getting its messages. The chat stays on this phone, read-only, until you delete it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => void engine.leaveGroup(groupId).catch(() => failed('leave the group')),
        },
      ],
    );
  }

  function deleteChat() {
    Alert.alert('Delete this chat?', 'Its messages are removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void engine.deleteConversation(groupId).then(() => router.dismissTo('/chats')),
      },
    ]);
  }

  const memberActions: SheetAction[] = [];
  if (chosen) {
    const member = chosen;
    memberActions.push({
      label: 'Message',
      onPress: () =>
        void engine.openDirectConversation(member.userId).then((direct) =>
          router.push({
            pathname: '/chat/[conversationId]',
            params: { conversationId: direct.conversationId },
          }),
        ),
    });
    memberActions.push({
      label: 'Contact info',
      onPress: () =>
        router.push({ pathname: '/contact/[userId]', params: { userId: member.userId } }),
    });
    if (myRole === 'owner' && member.role !== 'owner') {
      const promote = member.role === 'member';
      memberActions.push({
        label: promote ? 'Make admin' : 'Remove admin rights',
        onPress: () =>
          void engine
            .setGroupRole(groupId, member.userId, promote ? 'admin' : 'member')
            .catch(() => failed('change the role')),
      });
    }
    const canRemove =
      (myRole === 'owner' && member.role !== 'owner') ||
      (myRole === 'admin' && member.role === 'member');
    if (canRemove) {
      memberActions.push({
        label: 'Remove from group',
        destructive: true,
        onPress: () =>
          void engine.removeGroupMember(groupId, member.userId).catch(() => failed('remove them')),
      });
    }
  }

  return (
    <Screen offlineBanner>
      {editing ? (
        <View className="gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change group picture"
            onPress={() => void choosePicture()}
            className="items-center active:opacity-70"
          >
            <Avatar url={groupPictureUri(picture)} name={name || group.name} size={88} />
            <Text className="mt-1 text-primary">Change picture</Text>
          </Pressable>
          {picture && (
            <Button label="Remove picture" variant="ghost" onPress={() => setPicture(null)} />
          )}
          <TextField
            label="Group name"
            value={name}
            onChangeText={setName}
            maxLength={GROUP_NAME_MAX}
          />
          <TextField
            label="Description"
            value={description}
            onChangeText={setDescription}
            maxLength={GROUP_DESCRIPTION_MAX}
            multiline
          />
          <Button label="Save" loading={busy} onPress={() => void save()} />
          <Button label="Cancel" variant="ghost" onPress={() => setEditing(false)} />
        </View>
      ) : (
        <View className="items-center gap-2">
          <Avatar url={groupPictureUri(group.avatar)} name={group.name || 'Group'} size={88} />
          <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
            {group.name || 'Group'}
          </Text>
          {group.description !== '' && (
            <Text className="text-center text-muted">{group.description}</Text>
          )}
          {admin && (
            <Button
              label="Edit name, description or picture"
              variant="ghost"
              onPress={startEditing}
            />
          )}
        </View>
      )}
      {error && <Notice tone="error" message={error} />}
      {group.left && (
        <Notice message="You're no longer a member. New messages in this group don't reach you." />
      )}

      <ListSection title={`${group.members.length} member${group.members.length === 1 ? '' : 's'}`}>
        {admin && (
          <ListRow
            title="Add members"
            onPress={() => router.push({ pathname: '/add-members/[groupId]', params: { groupId } })}
          />
        )}
        {group.members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            self={member.userId === selfUserId}
            onPress={() => setChosen(member)}
          />
        ))}
      </ListSection>

      {!group.left && (
        <ListSection>
          <ListRow
            title="Mute notifications"
            onPress={() => void engine.setMuted(groupId, muted ? null : MUTED_FOREVER)}
            accessory={
              <Switch
                accessibilityLabel="Mute notifications"
                value={muted}
                onValueChange={(value) =>
                  void engine.setMuted(groupId, value ? MUTED_FOREVER : null)
                }
                trackColor={{ true: palette.primary, false: palette.border }}
              />
            }
          />
        </ListSection>
      )}

      <Text className="text-muted">
        Messages are end-to-end encrypted with keys that change whenever someone joins or leaves:
        people who leave can&apos;t read new messages, and people who join can&apos;t read earlier
        ones.
      </Text>

      <ListSection>
        {group.left ? (
          <ListRow title="Delete chat" destructive onPress={deleteChat} />
        ) : (
          <ListRow title="Leave group" destructive onPress={leave} />
        )}
      </ListSection>

      <ActionSheet
        visible={chosen !== undefined}
        onClose={() => setChosen(undefined)}
        actions={memberActions}
      />
    </Screen>
  );
}
