// Field messages that say what to change (Phase 34). They follow the shared schemas' real rules
// (`@pingdost/shared-types` auth.ts) and never repeat the input back.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const EMAIL_MAX = 254;
const DISPLAY_NAME_MAX = 64;

function characters(count: number): string {
  return count === 1 ? '1 more character' : `${count} more characters`;
}

function length(value: string): number {
  return [...value].length;
}

/** Why a username is not allowed, or undefined if the shape is fine. */
export function usernameProblem(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  if (name === '') return 'Choose a username';
  if (/\s/.test(name)) return 'No spaces: try _ or . instead';
  if (!/^[a-z0-9_.]+$/.test(name)) return 'Use only letters, digits, _ and .';
  if (name.length < USERNAME_MIN) return `Too short: add ${characters(USERNAME_MIN - name.length)}`;
  if (name.length > USERNAME_MAX) {
    return `Too long: ${USERNAME_MAX} characters at most (remove ${name.length - USERNAME_MAX})`;
  }
  return undefined;
}

/** What is wrong with an email address, or undefined if nothing obvious is. */
export function emailProblem(raw: string): string | undefined {
  const email = raw.trim();
  if (email === '') return 'Enter your email address';
  if (/\s/.test(email)) return 'Email addresses have no spaces';
  const at = email.indexOf('@');
  if (at === -1) return 'Missing the @, as in name@example.com';
  if (email.includes('@', at + 1)) return 'Use only one @';
  if (at === 0) return 'Add the part before the @, as in name@example.com';
  const domain = email.slice(at + 1);
  if (domain === '') return 'Add the part after the @, as in example.com';
  if (!domain.includes('.')) return 'The part after the @ needs a dot, as in example.com';
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return 'Check the part after the @, as in example.com';
  }
  if (email.length > EMAIL_MAX) return 'This email address is too long';
  return undefined;
}

/** For a new password: only length is a rule (tips live in `password-strength.ts`). */
export function newPasswordProblem(value: string): string | undefined {
  if (value === '') return 'Choose a password';
  const count = length(value);
  if (count < PASSWORD_MIN) return `Too short: add ${characters(PASSWORD_MIN - count)}`;
  if (count > PASSWORD_MAX) return `Too long: ${PASSWORD_MAX} characters at most`;
  return undefined;
}

export function otpProblem(raw: string): string | undefined {
  const code = raw.trim();
  if (code === '') return 'Enter the 6-digit code from the email';
  if (!/^\d+$/.test(code)) return 'The code has digits only';
  if (code.length !== 6) return `The code has 6 digits (${code.length} so far)`;
  return undefined;
}

/**
 * The message for a field that failed its schema, by field name, or undefined to fall back to
 * the generic one. The same names mean the same thing on every form.
 */
export function fieldMessage(field: string, value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : '';
  switch (field) {
    case 'username':
      return usernameProblem(text);
    case 'email':
      return emailProblem(text) ?? 'Check the address, as in name@example.com';
    case 'password':
    case 'newPassword':
      // Sign-in only needs something typed; sign-up and reset need the full rule.
      return text === '' ? 'Enter a password' : newPasswordProblem(text);
    case 'confirmPassword':
      return text === '' ? 'Type the password again' : 'Doesn’t match the password above';
    case 'otp':
      return otpProblem(text);
    case 'identifier':
      return text.trim() === ''
        ? 'Enter your email or username'
        : 'Enter your full email address or username';
    case 'displayName':
      return text.trim() === ''
        ? 'Enter a name'
        : length(text.trim()) > DISPLAY_NAME_MAX
          ? `Too long: ${DISPLAY_NAME_MAX} characters at most`
          : undefined;
    default:
      return undefined;
  }
}
