/**
 * Group system notices ("A added B"), stored as `kind: 'system'` messages whose body is
 * `group:` plus JSON. User IDs only: the app shows names from its own contacts.
 */
import type { GroupRole } from '../store';

export type GroupNotice =
  | { type: 'created'; by: string }
  /** This user was added and got the group's state from `by`. */
  | { type: 'joined'; by: string }
  | { type: 'added'; by: string; users: string[] }
  | { type: 'removed'; by: string; users: string[] }
  | { type: 'left'; users: string[] }
  | { type: 'role'; by: string; users: string[]; role: GroupRole }
  /** Name, description or picture changed. */
  | { type: 'info'; by: string }
  /** The server says this user is no longer a member. */
  | { type: 'not_member' };

const PREFIX = 'group:';

export function groupNoticeBody(notice: GroupNotice): string {
  return PREFIX + JSON.stringify(notice);
}

/** The group notice in a system message body, if it is one. */
export function parseGroupNotice(body: string): GroupNotice | undefined {
  if (!body.startsWith(PREFIX)) return undefined;
  try {
    const value = JSON.parse(body.slice(PREFIX.length)) as GroupNotice;
    return typeof value === 'object' && typeof value.type === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
