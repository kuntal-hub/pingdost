import type { ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface SheetAction {
  label: string;
  /** Shown under the label, e.g. what a delete really does. */
  detail?: string;
  destructive?: boolean;
  onPress: () => void;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Above the actions, e.g. a row of reactions. */
  header?: ReactNode;
  actions: SheetAction[];
}

/** A bottom sheet of actions (long-press menus). Choosing one closes the sheet first. */
export function ActionSheet({ visible, onClose, title, header, actions }: ActionSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        className="flex-1 justify-end"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
      >
        <Pressable
          // Taps inside the sheet must not close it.
          onPress={() => undefined}
          accessible={false}
          className="gap-1 rounded-t-xl bg-background px-2 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {title && (
            <Text numberOfLines={2} className="px-3 pb-2 text-center text-muted">
              {title}
            </Text>
          )}
          {header}
          {actions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={
                action.detail ? `${action.label}. ${action.detail}` : action.label
              }
              onPress={() => {
                onClose();
                action.onPress();
              }}
              className="min-h-[52px] justify-center rounded-md px-4 py-3 active:bg-surface"
            >
              <Text
                className={`text-base ${action.destructive ? 'text-danger' : 'text-foreground'}`}
              >
                {action.label}
              </Text>
              {action.detail && <Text className="text-muted">{action.detail}</Text>}
            </Pressable>
          ))}
          <View className="h-px bg-border" />
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            className="min-h-[52px] items-center justify-center rounded-md active:bg-surface"
          >
            <Text className="text-base font-semibold text-foreground">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
