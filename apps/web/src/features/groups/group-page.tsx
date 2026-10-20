// Group info and management (REQ §8.2, ADR 0016): name and description (admins), members with
// their roles, adding and removing members, making admins (the owner), and leaving. The name,
// description and picture are E2EE group content; the server only knows who is in it.
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { contactName, useContacts, type Contact } from '@/chat/contacts';
import { useGroup, useNames } from '@/chat/hooks';
import { useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, isAdmin, roleOf } from '@pingdost/message-engine';

import { groupName, groupPictureUri } from '../chats/format';
import { MemberPicker } from '../chats/new-chat';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: '' } as const;

export function GroupPage() {
  const { groupId = '' } = useParams();
  const client = useChatClient();
  const group = useGroup(groupId);
  const names = useNames();
  const contacts = useContacts((state) => state.byId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [adding, setAdding] = useState<Contact[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!group) return <div className="p-6 text-muted">Loading the group…</div>;
  const self = names.selfUserId;
  const admin = !group.left && isAdmin(roleOf(group, self));
  const owner = !group.left && roleOf(group, self) === 'owner';

  async function run(action: () => Promise<unknown>, failed: string) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(code === 'GROUP_FULL' ? 'The group is full.' : failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <Avatar name={groupName(group)} url={groupPictureUri(group.avatar)} size={64} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold">{groupName(group)}</h1>
            <p className="text-muted">
              {group.left ? "You're not a member" : `${group.members.length} members`}
            </p>
          </div>
          <Link to={`/chat/${groupId}`} className="text-primary underline">
            Open chat
          </Link>
        </div>
        {group.description && <p className="whitespace-pre-wrap">{group.description}</p>}
        {admin &&
          (editing ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await client?.updateGroupInfo(groupId, {
                    name: name.trim() || group.name,
                    description: description.trim(),
                    avatar: group.avatar,
                  });
                  setEditing(false);
                }, 'Could not save the group info.');
              }}
            >
              <Input
                value={name}
                maxLength={GROUP_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                aria-label="Group name"
              />
              <Textarea
                value={description}
                maxLength={GROUP_DESCRIPTION_MAX}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Description"
                rows={3}
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  Save
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => {
                setName(group.name);
                setDescription(group.description);
                setEditing(true);
              }}
            >
              Edit name and description
            </Button>
          ))}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Members</CardTitle>
        <ul className="flex flex-col gap-1">
          {group.members.map((member) => {
            const contact = contacts[member.userId];
            const label = member.userId === self ? 'You' : names.name(member.userId);
            const removable =
              member.userId !== self && (owner || (admin && member.role === 'member'));
            return (
              <li key={member.userId} className="flex items-center gap-3 rounded-md px-2 py-1">
                <Avatar
                  name={contact ? contactName(contact) : label}
                  url={contact?.avatarUrl}
                  size={36}
                />
                <span className="flex-1">
                  {member.userId === self ? (
                    label
                  ) : (
                    <Link to={`/contact/${member.userId}`}>{label}</Link>
                  )}
                </span>
                {ROLE_LABEL[member.role] && (
                  <span className="text-sm text-muted">{ROLE_LABEL[member.role]}</span>
                )}
                {(removable || (owner && member.userId !== self)) && (
                  <Menu
                    label={`Manage ${label}`}
                    trigger={
                      <Button variant="ghost" className="min-h-8 px-2">
                        ⋯
                      </Button>
                    }
                    items={[
                      ...(owner && member.role !== 'owner'
                        ? [
                            {
                              label: member.role === 'admin' ? 'Remove admin rights' : 'Make admin',
                              onSelect: () =>
                                void run(
                                  () =>
                                    client!.setGroupRole(
                                      groupId,
                                      member.userId,
                                      member.role === 'admin' ? 'member' : 'admin',
                                    ),
                                  'Could not change the role.',
                                ),
                            },
                          ]
                        : []),
                      ...(removable
                        ? [
                            {
                              label: 'Remove from group',
                              destructive: true,
                              onSelect: () =>
                                void run(
                                  () => client!.removeGroupMember(groupId, member.userId),
                                  'Could not remove them.',
                                ),
                            },
                          ]
                        : []),
                    ]}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {admin && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="font-medium">Add members</span>
            <MemberPicker
              members={adding}
              onChange={setAdding}
              exclude={group.members.map((m) => m.userId)}
            />
            {adding.length > 0 && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client?.addGroupMembers(
                      groupId,
                      adding.map((m) => m.userId),
                    );
                    setAdding([]);
                  }, 'Could not add them.')
                }
              >
                Add {adding.length}
              </Button>
            )}
          </div>
        )}
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {!group.left && (
        <Button
          variant="danger"
          className="self-start"
          disabled={busy}
          onClick={() => void run(() => client!.leaveGroup(groupId), 'Could not leave the group.')}
        >
          Leave group
        </Button>
      )}
      <p className="text-sm text-muted">Group calls are not part of PingDost.</p>
    </div>
  );
}
