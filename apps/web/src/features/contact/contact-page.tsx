// Contact info (REQ §7.3, ADR 0012): the profile, the safety number and its QR code (the
// contact's phone scans it to verify you), marking them verified after comparing, and blocking.
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { contactName, useContact } from '@/chat/contacts';
import { useSafetyNumber } from '@/chat/hooks';
import { prefsChanged } from '@/chat/start';
import { useChat, useChatClient, useCircleState } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { api } from '@/session/session';
import { encodeSafetyQr } from '@pingdost/protocol/safety-number';

import { CircleAction } from '../circle/circle-action';

export function ContactPage() {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const client = useChatClient();
  const contact = useContact(userId);
  const safety = useSafetyNumber(userId);
  const blocked = useChat((state) => state.blocked.includes(userId));
  const [verified, setVerified] = useState<boolean>();
  const [error, setError] = useState<string>();
  const name = contactName(contact);
  const isVerified = verified ?? safety.verified;

  async function toggleBlock() {
    setError(undefined);
    try {
      if (blocked) await api.security.unblock(userId);
      else await api.security.block(userId);
      useChat.setState((state) => ({
        blocked: blocked ? state.blocked.filter((id) => id !== userId) : [...state.blocked, userId],
      }));
      prefsChanged();
    } catch {
      setError('Could not change that. Check your connection.');
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <Card className="flex items-center gap-4">
        <Avatar name={name} url={contact?.avatarUrl} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{name}</h1>
          {contact?.username && <p className="text-muted">@{contact.username}</p>}
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            void client?.openDirectConversation(userId).then(
              (c) => navigate(`/chat/${c.conversationId}`),
              () => undefined,
            )
          }
        >
          Message
        </Button>
      </Card>

      <ContactCircle userId={userId} name={name} />

      <Card className="flex flex-col gap-3">
        <CardTitle className="flex items-center gap-2">
          Safety number{' '}
          {isVerified && <ShieldCheck aria-label="Verified" className="text-success" size={20} />}
        </CardTitle>
        {safety.number ? (
          <>
            <p className="text-muted">
              Compare these numbers with {name}, in person or on a call you trust. If they match,
              your messages are end-to-end encrypted with each other only. On their phone, they can
              scan this code instead.
            </p>
            <div
              className="grid grid-cols-4 gap-2 font-mono text-lg tracking-wider"
              aria-label="Safety number"
            >
              {safety.number.groups.map((group, i) => (
                <span key={i}>{group}</span>
              ))}
            </div>
            <div className="self-center rounded-lg bg-white p-2">
              <QrCode
                value={encodeSafetyQr(safety.number)}
                size={200}
                label={`Safety code for ${name}`}
              />
            </div>
            {isVerified ? (
              <Alert tone="success">You verified {name}.</Alert>
            ) : (
              <Button
                variant="secondary"
                onClick={() =>
                  void client
                    ?.markVerified(userId, safety.identityKey!)
                    .then(setVerified, () => setError('Could not save that.'))
                }
              >
                The numbers match: mark as verified
              </Button>
            )}
          </>
        ) : (
          <p className="text-muted">
            {safety.problem === 'no_contact_key'
              ? `${name} has not set up encryption yet.`
              : safety.problem === 'no_own_key'
                ? 'This browser has no account key to compare with. Link it again from your phone.'
                : 'Working out the safety number…'}
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Block</CardTitle>
        <p className="text-muted">
          {blocked
            ? `You blocked ${name}. Neither of you can message the other.`
            : `Blocked contacts can't message you, see when you're online, or see you typing.`}
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <Button
          variant={blocked ? 'secondary' : 'danger'}
          className="self-start"
          onClick={() => void toggleBlock()}
        >
          {blocked ? `Unblock ${name}` : `Block ${name}`}
        </Button>
      </Card>
    </div>
  );
}

/** Where this person stands with the circle (Phase 37). */
function ContactCircle({ userId, name }: { userId: string; name: string }) {
  const state = useCircleState(userId);
  if (state === undefined) return null;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Circle</CardTitle>
      {state === 'member' ? (
        <p className="text-muted">
          {name} is in your circle. You can message and call each other. Remove them in{' '}
          <Link to="/circle" className="text-accent underline">
            Circle
          </Link>
          .
        </p>
      ) : (
        <>
          {state === 'none' && (
            <p className="text-muted">
              {name} is not in your circle. Only people in your circle can message or call you.
            </p>
          )}
          <CircleAction userId={userId} name={name} />
        </>
      )}
    </Card>
  );
}
