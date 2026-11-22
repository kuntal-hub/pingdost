// Quitting an unfinished solo game counts as a loss and ends it (rules change 2026-11-22), so
// the solo screens ask first. Leaving the screen only pauses the game.
import { Alert } from 'react-native';

export function confirmQuit(title: string, confirm: string, onQuit: () => void): void {
  Alert.alert(title, 'An unfinished game counts as a loss.', [
    { text: 'Keep playing', style: 'cancel' },
    { text: confirm, style: 'destructive', onPress: onQuit },
  ]);
}
