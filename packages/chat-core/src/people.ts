// Finding people, the same on the phone and the web (Phase 38): circle members are matched on
// the device as the user types (nothing leaves it), the server's search adds everyone else.

export interface Person {
  userId: string;
  username: string | null;
  displayName: string | null;
}

/** Lower case, accents removed: "Zoë" matches "zoe". */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function words(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/**
 * Whether `query` names this person: the username starts with it, or every word of it starts a
 * word of the display name. An empty query matches everyone.
 */
export function matchesPerson(person: Person, query: string): boolean {
  const q = foldText(query.trim()).replace(/^@/, '');
  if (q === '') return true;
  if (person.username?.startsWith(q)) return true;
  const terms = words(q);
  if (terms.length === 0) return false;
  const name = words(person.displayName ?? '');
  return terms.every((term) => name.some((word) => word.startsWith(term)));
}

/** A whole email address, which the server search matches exactly (never a fragment). */
export function isWholeEmail(query: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim());
}

/** Worth asking the server: 2 characters or more (the server's minimum). */
export function searchable(query: string): boolean {
  return query.trim().replace(/^@/, '').length >= 2;
}

/** Local matches first, then the server's results not already shown. */
export function mergePeople<L extends { userId: string }, R extends { userId: string }>(
  local: readonly L[],
  remote: readonly R[],
): (L | R)[] {
  const seen = new Set(local.map((person) => person.userId));
  return [...local, ...remote.filter((person) => !seen.has(person.userId))];
}

/** Adds or removes `userId` from a picked list, keeping the order of picking. */
export function togglePicked(picked: readonly string[], userId: string): string[] {
  return picked.includes(userId) ? picked.filter((id) => id !== userId) : [...picked, userId];
}
