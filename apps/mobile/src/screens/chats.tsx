import { Text, View } from 'react-native';

/** Placeholder until 1:1 chat arrives (Phase 10). */
export function ChatsScreen() {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-background p-6">
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        No chats yet
      </Text>
      <Text className="text-center text-base text-muted">
        Messaging arrives in a coming update. Your account and this phone&apos;s encryption keys are
        ready.
      </Text>
    </View>
  );
}
