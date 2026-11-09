import { useState, type ComponentProps } from 'react';
import { Platform } from 'react-native';

import { EyeIcon, EyeOffIcon } from './icon';
import { IconButton } from './icon-button';
import { TextField } from './text-field';

type PasswordFieldProps = Omit<ComponentProps<typeof TextField>, 'secureTextEntry' | 'trailing'>;

/**
 * A password input with a show/hide button (Phase 34). Hidden by default and again whenever the
 * screen is left, since the state lives in the screen.
 */
export function PasswordField(props: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      secureTextEntry={!visible}
      // Shown, it is still a password: no suggestions, and the keyboard must not learn it.
      {...(visible && Platform.OS === 'android' ? { keyboardType: 'visible-password' } : {})}
      trailing={
        <IconButton
          icon={visible ? EyeOffIcon : EyeIcon}
          label={visible ? 'Hide password' : 'Show password'}
          feedback="selection"
          size={40}
          onPress={() => setVisible((shown) => !shown)}
        />
      }
    />
  );
}
