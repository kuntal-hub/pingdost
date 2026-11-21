// "Play Ludo" from a chat (Phase 42, ADR 0049): the rules, and in a group how many seats; the
// invitation goes into the chat as a card. People only: no computer players in games with
// friends.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { Segmented } from '@/components/controls';
import { SendIcon } from '@/components/icon';
import { ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { useChatRuntime, useConversationRecord } from '@/engine/hooks';
import { startLudoGame } from '@/games/network';
import { useGames } from '@/games/store';
import type { LudoSettings } from '@pingdost/games';

import { ToggleRow } from './ludo/ludo-setup';

export function StartGameScreen({ conversationId }: { conversationId: string }) {
  const runtime = useChatRuntime();
  const conversation = useConversationRecord(conversationId);
  const isGroup = conversation?.kind === 'group';
  const loaded = useGames((state) => state.loaded);
  const [settings, setSettings] = useState<LudoSettings>(
    () => useGames.getState().ludoSetup.settings,
  );
  const [players, setPlayers] = useState<'2' | '3' | '4'>('4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setSettings(useGames.getState().ludoSetup.settings));
  }, [loaded]);
  const setRule = (change: Partial<LudoSettings>) =>
    setSettings((current) => ({ ...current, ...change }));

  async function invite() {
    if (!runtime) return;
    setBusy(true);
    setError(undefined);
    try {
      const gameId = await startLudoGame(
        runtime,
        conversationId,
        settings,
        isGroup ? Number(players) : 2,
      );
      router.replace({ pathname: '/game/[gameId]', params: { gameId } });
    } catch {
      setError('The invitation could not be sent. Try again.');
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View className="gap-6">
        <Text className="px-2 text-sm text-muted">
          {isGroup
            ? 'Everyone in the group gets the invitation; the first to join take the seats.'
            : 'Your friend gets the invitation in this chat.'}
        </Text>
        {isGroup && (
          <View className="gap-2">
            <Text accessibilityRole="header" className="px-2 font-bold text-muted">
              Players
            </Text>
            <Segmented
              accessibilityLabel="Players"
              options={[
                { id: '2', label: '2' },
                { id: '3', label: '3' },
                { id: '4', label: '4' },
              ]}
              value={players}
              onChange={setPlayers}
            />
          </View>
        )}
        <ListSection title="Rules">
          <ToggleRow
            title="Roll a 6 to start"
            subtitle="Off: any roll brings a piece out."
            value={settings.needSix}
            onChange={(needSix) => setRule({ needSix })}
          />
          <ToggleRow
            title="Walls"
            subtitle="Two of your pieces on one square block everyone else."
            value={settings.blockades}
            onChange={(blockades) => setRule({ blockades })}
          />
          <ToggleRow
            title="End at the first winner"
            subtitle="Off: the others play on for places."
            value={settings.stopAtFirstWinner}
            onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
          />
        </ListSection>
        <Text className="px-2 text-xs text-muted">
          Each turn has 30 seconds. If you are away, your app plays for you while the game is open;
          otherwise your turn is skipped, and three skips in a row take you out.
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
