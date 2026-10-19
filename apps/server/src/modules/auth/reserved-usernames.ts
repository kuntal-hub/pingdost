/** Usernames nobody may register: they could impersonate the service or confuse users. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'abuse',
  'admin',
  'administrator',
  'api',
  'app',
  'bot',
  'contact',
  'help',
  'info',
  'mail',
  'me',
  'moderator',
  'mod',
  'noreply',
  'null',
  'official',
  'owner',
  'pingdost',
  'pingdost_official',
  'pingdost.official',
  'postmaster',
  'privacy',
  'root',
  'security',
  'staff',
  'support',
  'system',
  'team',
  'undefined',
  'webmaster',
  'www',
]);

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username) || username.startsWith('pingdost');
}
