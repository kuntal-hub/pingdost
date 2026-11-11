// The composer's emoji panel (Phase 36): in place of the keyboard and as tall as it, with
// categories, recents (this phone only), a skin tone and search. Search shrinks the panel to a
// strip of results above the keyboard, where the search words are typed.
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text as NativeText, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';

import {
  ArrowLeftIcon,
  ClockIcon,
  DeleteIcon,
  FlagIcon,
  HandIcon,
  Icon,
  LightbulbIcon,
  PawPrintIcon,
  PizzaIcon,
  PlaneIcon,
  SearchIcon,
  ShapesIcon,
  SmileIcon,
  VolleyballIcon,
  XIcon,
  type LucideIcon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Tap } from '@/components/tap';
import { Text, TextInput } from '@/components/text';
import { loadEmojiSet, useEmojiPrefs } from '@/emoji/store';
import { haptic } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  EMOJI_CATEGORIES,
  recentEntries,
  searchEmoji,
  SKIN_TONES,
  withTone,
  type EmojiCategoryId,
  type EmojiSet,
} from '@pingdost/chat-core/emoji';

const CATEGORY_ICONS: Record<EmojiCategoryId, LucideIcon> = {
  recent: ClockIcon,
  smileys: SmileIcon,
  people: HandIcon,
  animals: PawPrintIcon,
  food: PizzaIcon,
  travel: PlaneIcon,
  activities: VolleyballIcon,
  objects: LightbulbIcon,
  symbols: ShapesIcon,
  flags: FlagIcon,
};

/** Each emoji's touch target. */
const CELL = 46;
const EMOJI_SIZE = 28;
/** The search strip above the keyboard: the field and one row of results. */
export const SEARCH_STRIP_HEIGHT = 112;

type Row =
  | { type: 'header'; key: string; category: EmojiCategoryId; label: string }
  | { type: 'row'; key: string; cells: { emoji: string; label: string }[] };

function useEmojiSet(): EmojiSet | undefined {
  const [set, setSet] = useState<EmojiSet>();
  useEffect(() => {
    let live = true;
    void loadEmojiSet()
      .then((loaded) => live && setSet(loaded))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return set;
}

function EmojiCell({
  emoji,
  label,
  onPick,
}: {
  emoji: string;
  label: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPick(emoji)}
      className="items-center justify-center rounded-lg active:bg-accent/15"
      style={{ width: CELL, height: CELL }}
    >
      <NativeText style={{ fontSize: EMOJI_SIZE }} maxFontSizeMultiplier={1.2}>
        {emoji}
      </NativeText>
    </Pressable>
  );
}

export function EmojiPanel({
  height,
  bottomInset,
  searching,
  onSearchingChange,
  onPick,
  onBackspace,
}: {
  /** The keyboard's height (it includes the navigation bar). */
  height: number;
  bottomInset: number;
  /** The search strip instead of the full panel. */
  searching: boolean;
  onSearchingChange: (searching: boolean) => void;
  onPick: (emoji: string) => void;
  onBackspace: () => void;
}) {
  const set = useEmojiSet();
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const recents = useEmojiPrefs((state) => state.recents);
  const tone = useEmojiPrefs((state) => state.tone);
  const [choosingTone, setChoosingTone] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<EmojiCategoryId>('smileys');
  const list = useRef<FlashListRef<Row>>(null);
  const columns = Math.max(6, Math.floor((width - 16) / CELL));

  function pick(emoji: string) {
    haptic('selection');
    useEmojiPrefs.getState().used(emoji);
    onPick(emoji);
  }

  // Recents keep the tone they were used in; the rest follow the chosen tone.
  const rows = useMemo<Row[]>(() => {
    if (!set) return [];
    const out: Row[] = [];
    for (const { id, label } of EMOJI_CATEGORIES) {
      const cells =
        id === 'recent'
          ? recentEntries(set, recents).map((emoji) => ({
              emoji,
              label: set.byEmoji.get(emoji)?.label ?? emoji,
            }))
          : (set.categories.get(id) ?? []).map((entry) => ({
              emoji: withTone(entry, tone),
              label: entry.label,
            }));
      if (cells.length === 0) continue;
      out.push({ type: 'header', key: `h:${id}`, category: id, label });
      for (let index = 0; index < cells.length; index += columns) {
        out.push({
          type: 'row',
          key: `${id}:${index}`,
          cells: cells.slice(index, index + columns),
        });
      }
    }
    return out;
  }, [set, recents, tone, columns]);

  const shownCategories = rows.flatMap((row) => (row.type === 'header' ? [row.category] : []));
  const results = useMemo(() => (set ? searchEmoji(set, query, 80) : []), [set, query]);

  if (searching) {
    return (
      <View className="bg-surface px-2" style={{ height: SEARCH_STRIP_HEIGHT }}>
        <View className="h-[56px] flex-row items-center gap-1">
          <IconButton
            icon={ArrowLeftIcon}
            label="Back to all emoji"
            size={40}
            onPress={() => {
              setQuery('');
              onSearchingChange(false);
            }}
          />
          <TextInput
            accessibilityLabel="Search emoji"
            placeholder="Search emoji"
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
            className="h-[44px] flex-1 rounded-xl bg-background px-3 text-base text-foreground"
          />
          {query !== '' && (
            <IconButton icon={XIcon} label="Clear search" size={40} onPress={() => setQuery('')} />
          )}
        </View>
        {query.trim() !== '' && results.length === 0 ? (
          <Text className="px-3 py-3 text-muted">No emoji found</Text>
        ) : (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
          >
            {results.map((entry) => (
              <EmojiCell
                key={entry.emoji}
                emoji={withTone(entry, tone)}
                label={entry.label}
                onPick={pick}
              />
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  return (
    <View
      className="bg-surface"
      style={{ height, paddingBottom: bottomInset, borderTopWidth: 1, borderColor: palette.border }}
    >
      <View className="h-[52px] flex-row items-center gap-1 px-2">
        {choosingTone ? (
          <View
            className="flex-1 flex-row items-center justify-around"
            accessibilityRole="radiogroup"
          >
            {SKIN_TONES.map((option) => (
              <Tap
                key={option.tone}
                accessibilityRole="radio"
                accessibilityLabel={`${option.label} skin tone`}
                accessibilityState={{ checked: option.tone === tone }}
                feedback="selection"
                onPress={() => {
                  useEmojiPrefs.getState().setTone(option.tone);
                  setChoosingTone(false);
                }}
                className={`h-[44px] w-[44px] items-center justify-center rounded-full ${
                  option.tone === tone ? 'bg-accent/20' : ''
                }`}
              >
                <NativeText style={{ fontSize: 24 }} maxFontSizeMultiplier={1.2}>
                  {option.swatch}
                </NativeText>
              </Tap>
            ))}
          </View>
        ) : (
          <>
            <Tap
              accessibilityRole="search"
              accessibilityLabel="Search emoji"
              feedback="selection"
              scaleTo={0.98}
              onPress={() => onSearchingChange(true)}
              className="h-[40px] flex-1 flex-row items-center gap-2 rounded-xl bg-background px-3"
            >
              <Icon icon={SearchIcon} size={18} color="muted" />
              <Text className="text-muted">Search emoji</Text>
            </Tap>
            <Tap
              accessibilityLabel={`Skin tone: ${SKIN_TONES[tone]?.label ?? 'Default'}. Change`}
              feedback="selection"
              onPress={() => setChoosingTone(true)}
              className="h-[44px] w-[44px] items-center justify-center rounded-full"
            >
              <NativeText style={{ fontSize: 24 }} maxFontSizeMultiplier={1.2}>
                {SKIN_TONES[tone]?.swatch}
              </NativeText>
            </Tap>
          </>
        )}
        <IconButton icon={DeleteIcon} label="Delete" size={44} onPress={onBackspace} />
      </View>
      <View
        className="flex-1"
        style={{ paddingHorizontal: Math.floor((width - columns * CELL) / 2) }}
      >
        {set && (
          <FlashList
            ref={list}
            data={rows}
            keyExtractor={(row) => row.key}
            getItemType={(row) => row.type}
            keyboardShouldPersistTaps="always"
            onViewableItemsChanged={({ viewableItems }) => {
              const first = viewableItems.find((item) => item.isViewable)?.item;
              if (!first) return;
              const category =
                first.type === 'header'
                  ? first.category
                  : (first.key.split(':')[0] as EmojiCategoryId);
              setActive((current) => (current === category ? current : category));
            }}
            renderItem={({ item }) =>
              item.type === 'header' ? (
                <Text className="px-1 pb-1 pt-2 text-xs font-bold text-muted">{item.label}</Text>
              ) : (
                <View className="flex-row">
                  {item.cells.map((cell) => (
                    <EmojiCell
                      key={cell.emoji}
                      emoji={cell.emoji}
                      label={cell.label}
                      onPick={pick}
                    />
                  ))}
                </View>
              )
            }
          />
        )}
      </View>
      <View className="h-[44px] flex-row border-t border-border" accessibilityRole="tablist">
        {shownCategories.map((category) => {
          const selected = category === active;
          const label = EMOJI_CATEGORIES.find((c) => c.id === category)?.label ?? category;
          return (
            <Pressable
              key={category}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              onPress={() => {
                const index = rows.findIndex(
                  (row) => row.type === 'header' && row.category === category,
                );
                setActive(category);
                if (index >= 0) void list.current?.scrollToIndex({ index, animated: false });
              }}
              className="flex-1 items-center justify-center"
            >
              <Icon
                icon={CATEGORY_ICONS[category]}
                size={20}
                color={selected ? 'accent' : 'muted'}
              />
              {selected && (
                <View className="absolute bottom-0 h-[3px] w-6 rounded-full bg-accent" />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
