// "Play a game" from a chat (Phases 42–43, ADR 0049): which game, its rules, and in a group how
// many seats; the invitation goes into the chat as a card. People only: no computer players in
// games with friends.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { Segmented } from '@/components/controls';
import { GAME_ICONS, Icon, SendIcon } from '@/components/icon';
import { ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useChatRuntime, useConversationRecord } from '@/engine/hooks';
import { startGame } from '@/games/network';
import { turnSetupOf, useGames } from '@/games/store';
import {
  GAME_CATALOG,
  isTurnGameId,
  turnRules,
  type LudoSettings,
  type TurnGameId,
} from '@pingdost/games';

import { ToggleRow } from './ludo/ludo-setup';
import { TurnSettingsEditor } from './turn/turn-setup';

type Playable = 'ludo' | TurnGameId;

const PLAYABLE = GAME_CATALOG.filter((entry) => entry.available);

function settingsFor(game: Playable): unknown {
  const state = useGames.getState();
  return game === 'ludo' ? state.ludoSetup.settings : turnSetupOf(state, game).settings;
}

export function StartGameScreen({
  conversationId,
  initialGame,
}: {
  conversationId: string;
  initialGame?: Playable | undefined;
}) {
  const runtime = useChatRuntime();
  const conversation = useConversationRecord(conversationId);
  const isGroup = conversation?.kind === 'group';
  const loaded = useGames((state) => state.loaded);
  const [game, setGame] = useState<Playable>(initialGame ?? 'ludo');
  const [settings, setSettings] = useState<unknown>(() => settingsFor(initialGame ?? 'ludo'));
  const [players, setPlayers] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setSettings(settingsFor(game)));
    // Only the first load; later picks set their own settings.
  }, [loaded]);
  // A game for four needs a group.
  const choices = PLAYABLE.filter((e) => isGroup || e.minPlayers <= 2);
  const entry = choices.find((e) => e.id === game) ?? choices[0]!;
  const rules = isTurnGameId(game) ? turnRules(game) : null;
  const seats = Math.min(entry.maxPlayers, Math.max(entry.minPlayers, players));
  const pick = (next: Playable) => {
    setGame(next);
    setSettings(settingsFor(next));
  };

  async function invite() {
    if (!runtime) return;
    setBusy(true);
    setError(undefined);
    try {
      const gameId = await startGame(
        runtime,
        conversationId,
        entry.id as Playable,
        entry.id === game ? settings : settingsFor(entry.id as Playable),
        isGroup ? seats : 2,
      );
      router.replace({ pathname: '/game/[gameId]', params: { gameId } });
    } catch {
      setError('The invitation could not be sent. Try again.');
      setBusy(false);
    }
  }

  const ludo = settings as LudoSettings;
  const setRule = (change: Partial<LudoSettings>) => setSettings({ ...ludo, ...change });
  const timed = game === 'ludo' || rules?.turnMs !== null;

  return (
    <Screen>
      <View className="gap-6">
        <View className="gap-2">
          <Text accessibilityRole="header" className="px-2 font-bold text-muted">
            Game
          </Text>
          <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
            {choices.map((option) => {
              const selected = option.id === game;
              return (
                <Tap
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityLabel={option.name}
                  accessibilityState={{ selected }}
                  feedback="selection"
                  onPress={() => pick(option.id as Playable)}
                  className={`w-[31%] items-center gap-1 rounded-xl px-2 py-3 ${selected ? 'bg-primary' : 'bg-raised'}`}
                >
                  <Icon
                    icon={GAME_ICONS[option.icon]}
                    size={24}
                    color={selected ? 'on-primary' : 'accent'}
                  />
                  <Text
                    numberOfLines={1}
                    className={`text-xs font-semibold ${selected ? 'text-on-primary' : 'text-foreground'}`}
                  >
                    {option.name}
                  </Text>
                </Tap>
              );
            })}
          </View>
          <Text className="px-2 text-sm text-muted">{entry.tagline}</Text>
        </View>
        <Text className="px-2 text-sm text-muted">
          {isGroup
            ? 'Everyone in the group gets the invitation; the first to join take the seats.'
            : 'Your friend gets the invitation in this chat.'}
        </Text>
        {isGroup && entry.maxPlayers > 2 && (
          <View className="gap-2">
            <Text accessibilityRole="header" className="px-2 font-bold text-muted">
              Players
            </Text>
            <Segmented
              accessibilityLabel="Players"
              options={Array.from({ length: entry.maxPlayers - 1 }, (_, i) => ({
                id: String(i + 2),
                label: String(i + 2),
              }))}
              value={String(seats)}
              onChange={(id) => setPlayers(Number(id))}
            />
          </View>
        )}
        {game === 'ludo' ? (
          <ListSection title="Rules">
            <ToggleRow
              title="Roll a 6 to start"
              subtitle="Off: any roll brings a piece out."
              value={ludo.needSix}
              onChange={(needSix) => setRule({ needSix })}
            />
            <ToggleRow
              title="Walls"
              subtitle="Two of your pieces on one square block everyone else."
              value={ludo.blockades}
              onChange={(blockades) => setRule({ blockades })}
            />
            <ToggleRow
              title="End at the first winner"
              subtitle="Off: the others play on for places."
              value={ludo.stopAtFirstWinner}
              onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
            />
          </ListSection>
        ) : (
          rules && <TurnSettingsEditor rules={rules} settings={settings} onChange={setSettings} />
        )}
        <Text className="px-2 text-xs text-muted">
          {timed
            ? 'Each turn has 30 seconds. If you are away, your app plays for you while the game is open; otherwise the others play or skip your turn, and three missed turns in a row take you out.'
            : 'No timer: play at your own pace.'}
        </Text>
        {error && (
          <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-danger">
            {error}
          </Text>
        )}
        <Button
          label="Send invitation"
          icon={SendIcon}
          feedback="medium"
          disabled={!runtime || busy || !conversation}
          onPress={() => void invite()}
        />
      </View>
    </Screen>
  );
}
