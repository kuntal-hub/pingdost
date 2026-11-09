// A rough, local strength estimate for a new password (Phase 34). Advice only: the rule the
// server enforces is the length (`PasswordSchema`, 10–128 characters). Nothing leaves the phone.
import { PASSWORD_MIN } from '@/forms/messages';

export type StrengthScore = 0 | 1 | 2 | 3;

export interface PasswordStrength {
  /** 0 too short, 1 weak, 2 okay, 3 strong. */
  score: StrengthScore;
  label: 'Too short' | 'Weak' | 'Okay' | 'Strong';
  /** What would make it stronger, most useful first; empty when strong. */
  tips: string[];
}

/** Lowercase fragments that make a password easy to guess wherever they appear. */
const COMMON = [
  'password',
  'passwort',
  'passw0rd',
  'qwerty',
  'qwertz',
  'azerty',
  'asdfgh',
  '123456',
  '654321',
  '111111',
  'iloveyou',
  'letmein',
  'welcome',
  'admin',
  'pingdost',
  'abc123',
  'monkey',
  'dragon',
  'football',
  'sunshine',
  'princess',
];

const LABELS = ['Too short', 'Weak', 'Okay', 'Strong'] as const;

/** abcdef, 987654, aaaaaa: one step (−1, 0 or +1) between every pair of characters. */
function isRun(text: string): boolean {
  const codes = [...text].map((char) => char.codePointAt(0) ?? 0);
  if (codes.length < 3) return false;
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);
  if (Math.abs(step) > 1) return false;
  return codes.every((code, index) => index === 0 || code - (codes[index - 1] ?? 0) === step);
}

function characterKinds(password: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((kind) => kind.test(password)).length;
}

export function passwordStrength(
  password: string,
  context: { username?: string; email?: string } = {},
): PasswordStrength {
  const length = [...password].length;
  const result = (score: StrengthScore, tips: string[]): PasswordStrength => ({
    score,
    label: LABELS[score],
    tips: score === 3 ? [] : tips,
  });

  if (length < PASSWORD_MIN) {
    const missing = PASSWORD_MIN - length;
    return result(0, [`Add ${missing === 1 ? '1 more character' : `${missing} more characters`}`]);
  }

  const lower = password.toLowerCase();
  const tips: string[] = [];
  let guessable = false;

  const personal = [context.username, context.email?.split('@')[0]]
    .map((part) => part?.trim().toLowerCase() ?? '')
    .filter((part) => part.length >= 3);
  if (personal.some((part) => lower.includes(part))) {
    guessable = true;
    tips.push('Leave your username and email out of it');
  }
  if (COMMON.some((word) => lower.includes(word))) {
    guessable = true;
    tips.push('Avoid common words and patterns like “password” or “123456”');
  }
  if (isRun(lower) || new Set(lower).size <= 3) {
    guessable = true;
    tips.push('Use more different characters, not a run like “abcdef”');
  }

  const kinds = characterKinds(password);
  if (kinds < 3) tips.push('Mix in numbers or symbols, like 7 or #');
  if (length < 16) tips.push('Longer is stronger: a short phrase of a few words works well');

  if (guessable) return result(1, tips);
  if (length >= 16 || (length >= 12 && kinds >= 3)) return result(3, tips);
  if (kinds >= 2 || length >= 14) return result(2, tips);
  return result(1, tips);
}
