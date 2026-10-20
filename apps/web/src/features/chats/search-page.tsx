// Local search (REQ §8.1, ADR 0014): every term as a word prefix, case- and accent-blind, in
// texts and captions, over what this browser stores; nothing is sent anywhere. With `?c=` it
// searches one chat.
import { useDeferredValue, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { useNames } from '@/chat/hooks';
import { useChatClient } from '@/chat/store';
import { Input } from '@/components/ui/input';
import { timeLabel } from '@pingdost/chat-core';
import { highlightRanges, type MessageRecord } from '@pingdost/message-engine';

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, i) => {
    if (range.start > at) parts.push(text.slice(at, range.start));
    parts.push(
      <mark key={i} className="rounded bg-primary/25 text-inherit">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function SearchPage() {
  const [params] = useSearchParams();
  const conversationId = params.get('c') ?? undefined;
  const client = useChatClient();
  const names = useNames();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [results, setResults] = useState<MessageRecord[]>([]);

  useEffect(() => {
    if (!client || deferred.trim() === '') {
      setResults([]);
      return;
    }
    let live = true;
    void client.search(deferred, { limit: 50, ...(conversationId ? { conversationId } : {}) }).then(
      (found) => live && setResults(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, deferred, conversationId]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <Input
        autoFocus
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={conversationId ? 'Search this chat' : 'Search all chats'}
        aria-label="Search messages"
      />
      <p className="text-sm text-muted">Searches messages stored in this browser only.</p>
      <ul className="flex flex-col gap-1" aria-live="polite">
        {deferred.trim() !== '' && results.length === 0 && (
          <li className="text-muted">No messages found.</li>
        )}
        {results.map((message) => (
          <li key={message.messageId}>
            <Link
              to={`/chat/${message.conversationId}?m=${message.messageId}`}
              className="block rounded-md px-3 py-2 hover:bg-surface"
            >
              <span className="flex justify-between text-sm text-muted">
                <span>
                  {message.direction === 'out' ? 'You' : names.name(message.senderUserId)}
                </span>
                <span>
                  {new Date(message.sortAt).toLocaleDateString()} {timeLabel(message.sortAt)}
                </span>
              </span>
              <span className="line-clamp-2">
                <Highlighted text={message.body} query={deferred} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
