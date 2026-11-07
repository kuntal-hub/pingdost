import { Tabs } from 'expo-router/js-tabs';

import { FloatingTabBar } from '@/components/floating-tab-bar';

export default function AppTabs() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false, animation: 'none' }}
    >
      <Tabs.Screen name="(chats)" options={{ title: 'Chats' }} />
      <Tabs.Screen name="(calls)" options={{ title: 'Calls' }} />
      <Tabs.Screen name="(settings)" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
