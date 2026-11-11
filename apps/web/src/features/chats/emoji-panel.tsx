// The composer's emoji panel on the web (Phase 36): the same data as the phone's, opened by the
// button beside the message field. Search, categories, skin tone, recents in this browser.
// Arrow keys move through the grid, Enter picks, Escape closes.
import {
  Apple,
  Clock,
  Flag,
  Hand,
  Lightbulb,
  PawPrint,
  Plane,
  Search,
  Shapes,
  Smile,
  Volleyball,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import {
  EMOJI_CATEGORIES,
  recentEntries,
  searchEmoji,
  SKIN_TONES,
  withTone,
  type EmojiCategoryId,
  type EmojiSet,
} from '@pingdost/chat-core/emoji';

import { loadEmojiSet, useEmojiPrefs } from './emoji-data';

const ICONS: Record<EmojiCategoryId, LucideIcon> = {
  recent: Clock,
  smileys: Smile,
  people: Hand,
  animals: PawPrint,
  food: Apple,
  travel: Plane,
  activities: Volleyball,
  objects: Lightbulb,
  symbols: Shapes,
  flags: Flag,
};

const COLUMNS = 8;

interface Section {
  id: EmojiCategoryId;
  label: string;
  cells: { emoji: string; label: string }[];
}

export function EmojiPanel({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  /** Escape, or a click outside: focus goes back to the message field. */
  onClose: () => void;
}) {
  const [set, setSet] = useState<EmojiSet>();
  const [failed, setFailed] = useState(false);
  const recents = useEmojiPrefs((state) => state.recents);
  const tone = useEmojiPrefs((state) => state.tone);
  const [query, setQuery] = useState('');
  const [choosingTone, setChoosingTone] = useState(false);
  const [chosen, setActive] = useState<EmojiCategoryId>();
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<EmojiCategoryId, HTMLElement>());

  useEffect(() => {
    let live = true;
    loadEmojiSet().then(
      (loaded) => live && setSet(loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // A click outside closes the panel (the emoji button toggles it itself).
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-emoji-toggle]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [onClose]);

  const sections = useMemo<Section[]>(() => {
    if (!set) return [];
    const trimmed = query.trim();
    if (trimmed !== '') {
      return [
        {
          id: 'recent',
          label: 'Search results',
          cells: searchEmoji(set, trimmed).map((entry) => ({
            emoji: withTone(entry, tone),
            label: entry.label,
          })),
        },
      ];
    }
    return EMOJI_CATEGORIES.map(({ id, label }) => ({
      id,
      label,
      cells:
        id === 'recent'
          ? recentEntries(set, recents).map((emoji) => ({
              emoji,
              label: set.byEmoji.get(emoji)?.label ?? emoji,
            }))
          : (set.categories.get(id) ?? []).map((entry) => ({
              emoji: withTone(entry, tone),
              label: entry.label,
            })),
    })).filter((section) => section.cells.length > 0);
  }, [set, recents, tone, query]);

  const searching = query.trim() !== '';
  const active = chosen ?? sections[0]?.id;

  function pick(emoji: string) {
    useEmojiPrefs.getState().used(emoji);
    onPick(emoji);
  }

  function onScroll() {
    const element = scroller.current;
    if (!element || searching) return;
    let current: EmojiCategoryId | undefined;
    for (const section of sections) {
      const node = sectionRefs.current.get(section.id);
      // The scroller is positioned (relative): offsets are measured from its top.
      if (node && node.offsetTop <= element.scrollTop + 8) current = section.id;
    }
    if (current) setActive(current);
  }

  // Arrow keys move between emoji buttons in the grid (one tab stop for the whole grid).
  function gridKeys(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [
      ...(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + step))];
    next?.focus();
  }

  let first = true;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Emoji"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="pd-floating pd-rise absolute right-0 bottom-full z-20 mb-2 flex h-96 w-[22.5rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2 p-2">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-background px-3">
          <Search aria-hidden size={16} className="shrink-0 text-muted" />
          <input
            // The panel opens to search: typing finds an emoji at once.
            autoFocus
            aria-label="Search emoji"
            placeholder="Search emoji"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && sections[0]?.cells[0]) {
                event.preventDefault();
                pick(sections[0].cells[0].emoji);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                scroller.current?.querySelector<HTMLButtonElement>('button[data-emoji]')?.focus();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted focus:outline-none"
          />
        </label>
        <button
          type="button"
          aria-label={`Skin tone: ${SKIN_TONES[tone]?.label ?? 'Default'}. Change`}
          aria-expanded={choosingTone}
          onClick={() => setChoosingTone((open) => !open)}
          className="flex size-10 items-center justify-center rounded-full text-xl hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {SKIN_TONES[tone]?.swatch}
        </button>
      </div>
      {choosingTone && (
        <div role="radiogroup" aria-label="Skin tone" className="flex justify-around px-2 pb-2">
          {SKIN_TONES.map((option) => (
            <button
              key={option.tone}
              type="button"
              role="radio"
              aria-checked={option.tone === tone}
              aria-label={`${option.label} skin tone`}
              onClick={() => {
                useEmojiPrefs.getState().setTone(option.tone);
                setChoosingTone(false);
              }}
              className={cn(
                'flex size-10 items-center justify-center rounded-full text-xl hover:bg-accent/15',
                option.tone === tone && 'bg-accent/20',
              )}
            >
              {option.swatch}
            </button>
          ))}
        </div>
      )}
      {!searching && (
        <div
          role="tablist"
          aria-label="Emoji categories"
          className="flex border-b border-border px-1"
        >
          {sections.map((section) => {
            const Glyph = ICONS[section.id];
            const selected = section.id === active;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={section.label}
                title={section.label}
                onClick={() => {
                  setActive(section.id);
                  const node = sectionRefs.current.get(section.id);
                  if (node && scroller.current) {
                    scroller.current.scrollTop = node.offsetTop;
                  }
                }}
                className={cn(
                  'relative flex h-10 flex-1 items-center justify-center text-muted hover:text-foreground',
                  selected && 'text-accent',
                )}
              >
                <Glyph aria-hidden size={18} />
                {selected && (
                  <span className="absolute bottom-0 h-[3px] w-5 rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={gridKeys}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {failed ? (
          <p className="p-4 text-center text-muted">The emoji could not be loaded.</p>
        ) : !set ? (
          <p className="pd-skeleton p-4 text-center text-muted">Loading emoji…</p>
        ) : searching && sections[0]?.cells.length === 0 ? (
          <p className="p-4 text-center text-muted">No emoji found</p>
        ) : (
          sections.map((section) => (
            <section
              key={section.id}
              ref={(node) => {
                if (node) sectionRefs.current.set(section.id, node);
                else sectionRefs.current.delete(section.id);
              }}
              aria-label={section.label}
              className="[content-visibility:auto] [contain-intrinsic-size:auto_20rem]"
            >
              <h3 className="sticky top-0 bg-surface px-1 pt-2 pb-1 text-xs font-bold text-muted">
                {section.label}
              </h3>
              <div className="grid grid-cols-8">
                {section.cells.map((cell) => {
                  const tabIndex = first ? 0 : -1;
                  first = false;
                  return (
                    <button
                      key={cell.emoji}
                      type="button"
                      data-emoji
                      tabIndex={tabIndex}
                      aria-label={cell.label}
                      title={cell.label}
                      onClick={() => pick(cell.emoji)}
                      className="flex aspect-square items-center justify-center rounded-lg text-2xl leading-none hover:bg-accent/15 focus-visible:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {cell.emoji}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
