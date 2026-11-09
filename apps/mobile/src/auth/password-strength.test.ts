import { describe, expect, it } from 'vitest';

import { passwordStrength } from './password-strength';

describe('passwordStrength', () => {
  it('counts what is missing below the length rule', () => {
    expect(passwordStrength('abc')).toEqual({
      score: 0,
      label: 'Too short',
      tips: ['Add 7 more characters'],
    });
    expect(passwordStrength('abcdefgh1').tips).toEqual(['Add 1 more character']);
  });

  it('suggests numbers or symbols and length for plain passwords', () => {
    const plain = passwordStrength('sunnydayzz');
    expect(plain.score).toBe(1);
    expect(plain.tips).toEqual([
      'Mix in numbers or symbols, like 7 or #',
      'Longer is stronger: a short phrase of a few words works well',
    ]);
    expect(passwordStrength('sunnyday42').score).toBe(2);
  });

  it('rates long phrases and mixed passwords strong, without tips', () => {
    expect(passwordStrength('correct horse battery staple')).toEqual({
      score: 3,
      label: 'Strong',
      tips: [],
    });
    expect(passwordStrength('Tr4m-Lime-9x').score).toBe(3);
  });

  it('marks guessable passwords weak, whatever their length', () => {
    expect(passwordStrength('MyPassword2026!').tips[0]).toBe(
      'Avoid common words and patterns like “password” or “123456”',
    );
    expect(passwordStrength('MyPassword2026!').score).toBe(1);
    expect(passwordStrength('abcdefghijklmnop').score).toBe(1);
    expect(passwordStrength('zzzzzzzzzzzzzzzzzz').score).toBe(1);
    const personal = passwordStrength('alice.dev is here 99', {
      username: 'alice.dev',
      email: 'someone@example.com',
    });
    expect(personal).toMatchObject({ score: 1 });
    expect(personal.tips[0]).toBe('Leave your username and email out of it');
    expect(passwordStrength('someone-likes-tea', { email: 'someone@example.com' }).score).toBe(1);
  });
});
