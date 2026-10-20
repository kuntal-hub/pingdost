import { Card, CardTitle } from '@/components/ui/card';

/** The chat list; empty until chat on the web arrives (Phase 17). */
export function ChatsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-bold">Chats</h1>
      <Card className="flex flex-col gap-2">
        <CardTitle>This browser is linked</CardTitle>
        <p className="text-muted">
          No chats here yet. Your messages stay end-to-end encrypted on every device, this browser
          included.
        </p>
      </Card>
    </div>
  );
}
