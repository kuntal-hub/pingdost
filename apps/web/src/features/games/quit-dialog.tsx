// Quitting an unfinished solo game counts as a loss and ends it (rules change 2026-11-22), so
// the solo pages ask first. Leaving the page only pauses the game.
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/menu';

export interface QuitAsk {
  title: string;
  confirm: string;
  run: () => void;
}

export function QuitDialog({ ask, onClose }: { ask: QuitAsk | null; onClose: () => void }) {
  return (
    <Dialog
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={ask?.title ?? 'End this game?'}
      description="An unfinished game counts as a loss."
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep playing
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose();
            ask?.run();
          }}
        >
          {ask?.confirm ?? 'End game'}
        </Button>
      </div>
    </Dialog>
  );
}
