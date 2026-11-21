// Game sounds on the phone (ADR 0050): generated once by `@pingdost/games`, written to the
// cache as WAV files, and played with expo-audio. The app's audio mode is left alone, so voice
// notes and calls are not affected. Android has no silent-mode check without native code:
// sounds follow the media volume and the Game sounds switch.
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

import { encodeWav, GAME_SOUND_RATE, synthesizeGameSound, type GameSound } from '@pingdost/games';

import { useGames } from './store';

const players = new Map<GameSound, AudioPlayer>();
const VERSION = 1;

function playerFor(kind: GameSound): AudioPlayer | null {
  const ready = players.get(kind);
  if (ready) return ready;
  try {
    const file = new File(Paths.cache, `pingdost-game-${kind}-v${VERSION}.wav`);
    if (!file.exists) {
      file.create({ intermediates: true });
      file.writeSync(encodeWav(synthesizeGameSound(kind), GAME_SOUND_RATE));
    }
    const player = createAudioPlayer({ uri: file.uri });
    player.volume = 0.7;
    players.set(kind, player);
    return player;
  } catch {
    // No sound is better than a broken game.
    return null;
  }
}

/** Plays a game sound if the user has Game sounds on. */
export function playGameSound(kind: GameSound): void {
  if (!useGames.getState().sounds) return;
  const player = playerFor(kind);
  if (!player) return;
  void player.seekTo(0).then(
    () => player.play(),
    () => player.play(),
  );
}

/** Frees the players when the game screen closes. */
export function releaseGameSounds(): void {
  for (const player of players.values()) player.remove();
  players.clear();
}
