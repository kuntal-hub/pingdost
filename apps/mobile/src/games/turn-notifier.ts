// "It's your turn" (Phase 42, ADR 0049): a local notification when a game with friends comes to
// this phone's seat while the app is not on screen. It never leaves the phone (the server cannot
// tell game events from messages). A muted chat stays quiet. One notification per game, replaced
// by the next.
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { getCryptoContext } from '@/crypto/bootstrap';
import { foldAnyGame, gameTypeLabel } from '@pingdost/games';
import type { MessageEngine } from '@pingdost/message-engine';

/** The notification of a game (also dismissed when its screen opens). */
export function turnNotificationId(gameId: string): string {
  return `game-${gameId}`;
}

export function dismissTurnNotification(gameId: string): void {
  void Notifications.dismissNotificationAsync(turnNotificationId(gameId)).catch(() => undefined);
}

async function check(engine: MessageEngine, gameId: string, channelId: string): Promise<void> {
  if (AppState.currentState === 'active') return;
  const record = await engine.getGame(gameId);
  if (!record) return;
  const { provider } = await getCryptoContext();
  const folded = foldAnyGame(record.gameType, gameId, await engine.listGameEvents(gameId), (data) =>
    provider.sha256(data),
  );
  if (!folded) return;
  const { game } = folded;
  const seat = game.seats.findIndex(
    (s) => s.userId === engine.self.userId && s.deviceId === engine.self.deviceId,
  );
  if (game.phase !== 'playing' || seat < 0 || game.state?.current !== seat) return;
  const conversation = await engine.getConversation(record.conversationId);
  const mutedUntil = conversation?.mutedUntil ?? null;
  if (mutedUntil !== null && mutedUntil > Date.now()) return;
  const timed = folded.type === 'ludo' || folded.rules.turnMs !== null;
  const roll = folded.type === 'ludo' || folded.rules.dice;
  await Notifications.scheduleNotificationAsync({
    identifier: turnNotificationId(gameId),
    content: {
      title: `Your turn in ${gameTypeLabel(record.gameType)}`,
      body: timed
        ? `You have 30 seconds to ${roll ? 'roll' : 'play'}.`
        : 'Make your move when you are ready.',
      data: { conversationId: record.conversationId, gameId },
    },
    trigger: Platform.OS === 'android' ? { channelId } : null,
  });
}

/** Watches game events from other devices; returns the unsubscribe. */
export function installTurnNotifier(engine: MessageEngine, channelId: string): () => void {
  return engine.onGameEvent((event) => {
    if (event.senderDeviceId === engine.self.deviceId) return;
    void check(engine, event.gameId, channelId).catch((error: unknown) => {
      if (__DEV__) console.warn('[games] turn notification failed', error);
    });
  });
}
