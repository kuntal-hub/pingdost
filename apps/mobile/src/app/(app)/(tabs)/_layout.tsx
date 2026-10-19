import { NativeTabs } from 'expo-router/native-tabs';

import { usePalette } from '@/theme/theme-root';

export default function AppTabs() {
  const palette = usePalette();
  return (
    <NativeTabs
      backgroundColor={palette.surface}
      tintColor={palette.primary}
      iconColor={palette.muted}
      indicatorColor={palette.border}
    >
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="chat" />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
