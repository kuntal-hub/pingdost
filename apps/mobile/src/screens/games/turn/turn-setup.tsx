// Setting up a turn game against the computer (Phase 43): how many computer players where the
// game allows more than one, how hard they play (not for Snakes and Ladders: the dice decide),
// and the game's options. Computer players exist only in games on your own (ADR 0049).
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { Segmented } from '@/components/controls';
import { PlayIcon } from '@/components/icon';
import { ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { turnSetupOf, useGames } from '@/games/store';
import {
  BLINDS_EVERY,
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  DOTS_SIZES,
  formatChips,
  POKER_CHIPS,
  turnRules,
  type AnyTurnRules,
  type BotLevel,
  type ChessSettings,
  type DotsSettings,
  type PokerSettings,
  type SnakesSettings,
  type TurnGameId,
  type TurnSoloOptions,
} from '@pingdost/games';

import { ToggleRow } from '../ludo/ludo-setup';

const LEVEL_DETAIL: Partial<Record<TurnGameId, Record<BotLevel, string>>> = {
  'tic-tac-toe': {
    easy: 'Plays almost anywhere.',
    medium: 'Takes its wins and blocks yours.',
    hard: 'Never loses. A draw is a good result.',
  },
  'connect-four': {
    easy: 'Looks one move ahead, and slips now and then.',
    medium: 'Looks four moves ahead.',
    hard: 'Looks six moves ahead.',
  },
  'dots-and-boxes': {
    easy: 'Often hands boxes over.',
    medium: 'Takes every box and never gives one away early.',
    hard: 'Fights for the last safe line and keeps control of long chains.',
  },
  'last-card': {
    easy: 'Plays any card that fits, and sometimes forgets to call.',
    medium: 'Saves wilds, and hits the next player when they are close to out.',
    hard: 'Also keeps to its strongest color and plays draw four early on a threat.',
  },
  'call-bridge': {
    easy: 'Plays any card it may and calls loosely.',
    medium: 'Calls from its high cards and trumps, and wins tricks only when it needs them.',
    hard: 'Plays out sample deals of the unseen cards to pick each card.',
  },
  poker: {
    easy: 'Misreads its cards, calls too much and bluffs at random.',
    medium: 'Bets good hands, calls when the price is right, bluffs now and then.',
    hard: 'Reads raises, bets for value and bluffs when few players are left.',
  },
  chess: {
    easy: 'Looks one move ahead and often picks a weaker move.',
    medium: 'Looks about three moves ahead.',
    hard: 'Thinks up to a second and a half per move, as deep as it can.',
  },
};

/** The game's own options (shared with the invitation screen). */
export function TurnSettingsEditor({
  rules,
  settings,
  onChange,
}: {
  rules: AnyTurnRules;
  settings: unknown;
  onChange: (settings: unknown) => void;
}) {
  if (rules.id === 'dots-and-boxes') {
    const value = settings as DotsSettings;
    return (
      <View className="gap-2">
        <Text accessibilityRole="header" className="px-2 font-bold text-muted">
          Board
        </Text>
        <Segmented
          accessibilityLabel="Board size"
          options={DOTS_SIZES.map((size) => ({ id: String(size), label: `${size}×${size}` }))}
          value={String(value.size)}
          onChange={(size) => onChange({ ...value, size: Number(size) })}
        />
        <Text className="px-2 text-sm text-muted">Boxes per side. Bigger boards take longer.</Text>
      </View>
    );
  }
  if (rules.id === 'chess') {
    const value = settings as ChessSettings;
    return (
      <View className="gap-2">
        <Text accessibilityRole="header" className="px-2 font-bold text-muted">
          Your side
        </Text>
        <Segmented
          accessibilityLabel="Your side"
          options={[
            { id: 'white', label: 'White' },
            { id: 'random', label: 'Random' },
            { id: 'black', label: 'Black' },
          ]}
          value={value.hostSide}
          onChange={(hostSide) => onChange({ ...value, hostSide })}
        />
        <Text className="px-2 text-sm text-muted">White moves first.</Text>
      </View>
    );
  }
  if (rules.id === 'poker') {
    const value = settings as PokerSettings;
    return (
      <View className="gap-2">
        <Text accessibilityRole="header" className="px-2 font-bold text-muted">
          Starting chips
        </Text>
        <Segmented
          accessibilityLabel="Starting chips"
          options={POKER_CHIPS.map((chips) => ({ id: String(chips), label: formatChips(chips) }))}
          value={String(value.chips)}
          onChange={(chips) => onChange({ ...value, chips: Number(chips) })}
        />
        <ListSection title="Blinds">
          <ToggleRow
            title="Blinds go up"
            subtitle={`Double every ${BLINDS_EVERY} hands, so the game ends in good time. Off: always 10 and 20.`}
            value={value.risingBlinds}
            onChange={(risingBlinds) => onChange({ ...value, risingBlinds })}
          />
        </ListSection>
        <Text className="px-2 text-sm text-muted">
          Play chips only: no real money, nothing to buy and nothing to win.
        </Text>
      </View>
    );
  }
  if (rules.id === 'snakes-and-ladders') {
    const value = settings as SnakesSettings;
    return (
      <ListSection title="Rules">
        <ToggleRow
          title="A 6 rolls again"
          subtitle="Up to two extra rolls in a row."
          value={value.sixRollsAgain}
          onChange={(sixRollsAgain) => onChange({ ...value, sixRollsAgain })}
        />
        <ToggleRow
          title="Bounce back from 100"
          subtitle="Off: a roll past 100 doesn't move."
          value={value.bounceBack}
          onChange={(bounceBack) => onChange({ ...value, bounceBack })}
        />
      </ListSection>
    );
  }
  return null;
}

export function TurnSetupScreen({ game }: { game: TurnGameId }) {
  const rules = turnRules(game);
  const loaded = useGames((state) => state.loaded);
  const saved = useGames((state) => state.turnSolo[game]);
  const sounds = useGames((state) => state.sounds);
  const [options, setOptions] = useState<TurnSoloOptions>(() =>
    turnSetupOf(useGames.getState(), game),
  );
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setOptions(turnSetupOf(useGames.getState(), game)));
  }, [loaded, game]);
  const unfinished = saved !== undefined && saved.state.ranks === null;
  const most = rules.maxPlayers - 1;
  const least = Math.max(1, rules.minPlayers - 1);
  const detail = LEVEL_DETAIL[game]?.[options.level];

  return (
    <Screen>
      <View className="gap-6">
        {most > least && (
          <View className="gap-2">
            <Text accessibilityRole="header" className="px-2 font-bold text-muted">
              Computer players
            </Text>
            <Segmented
              accessibilityLabel="Computer players"
              options={Array.from({ length: most - least + 1 }, (_, i) => ({
                id: String(i + least),
                label: String(i + least),
              }))}
              value={String(options.computers)}
              onChange={(id) => setOptions({ ...options, computers: Number(id) })}
            />
          </View>
        )}
        {rules.levels ? (
          <View className="gap-2">
            <Text accessibilityRole="header" className="px-2 font-bold text-muted">
              Difficulty
            </Text>
            <Segmented
              accessibilityLabel="Difficulty"
              options={BOT_LEVELS.map((level) => ({ id: level, label: BOT_LEVEL_NAMES[level] }))}
              value={options.level}
              onChange={(level) => setOptions({ ...options, level })}
            />
            {detail && <Text className="px-2 text-sm text-muted">{detail}</Text>}
          </View>
        ) : (
          <Text className="px-2 text-sm text-muted">
            The dice decide every move, so the computer players have no difficulty levels.
          </Text>
        )}
        <TurnSettingsEditor
          rules={rules}
          settings={options.settings}
          onChange={(settings) => setOptions({ ...options, settings })}
        />
        <ListSection title="While playing">
          <ToggleRow
            title="Game sounds"
            subtitle="Moves, dice and wins."
            value={sounds}
            onChange={(value) => useGames.getState().setSounds(value)}
          />
        </ListSection>
        <View className="gap-2">
          <Button
            label="Start game"
            icon={PlayIcon}
            feedback="medium"
            onPress={() => {
              useGames.getState().startTurnSolo(game, options);
              router.replace({ pathname: '/game/play', params: { game } });
            }}
          />
          {unfinished && (
            <Text className="px-2 text-center text-sm text-muted">
              Starting counts your unfinished game as a loss.
            </Text>
          )}
        </View>
        <Text className="px-2 text-xs text-muted">
          Computer players are only for games on your own; games with friends are people only. Games
          against the computer run on this phone and send nothing.
        </Text>
      </View>
    </Screen>
  );
}
