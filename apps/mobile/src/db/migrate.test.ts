import { describe, expect, it } from 'vitest';

import { migrate, migrations, type Migration, type MigratableDatabase } from './migrate';

/** An in-memory stand-in that records executed SQL and honours BEGIN / COMMIT / ROLLBACK. */
function fakeDatabase(startVersion = 0) {
  const state = { version: startVersion, executed: [] as string[] };
  let snapshot: typeof state | undefined;
  const db: MigratableDatabase = {
    getFirstAsync: <T>() => Promise.resolve({ user_version: state.version } as T),
    execAsync(source) {
      if (source === 'BEGIN IMMEDIATE') {
        if (snapshot) return Promise.reject(new Error('nested transaction'));
        snapshot = { ...state, executed: [...state.executed] };
      } else if (source === 'COMMIT') {
        snapshot = undefined;
      } else if (source === 'ROLLBACK') {
        if (snapshot) Object.assign(state, snapshot);
        snapshot = undefined;
      } else if (source.includes('FAIL')) {
        return Promise.reject(new Error('sql error'));
      } else {
        if (!snapshot) return Promise.reject(new Error('statement outside a transaction'));
        const bump = /PRAGMA user_version = (\d+)/.exec(source);
        if (bump) state.version = Number(bump[1]);
        else state.executed.push(source.trim());
      }
      return Promise.resolve();
    },
  };
  return { db, state };
}

const extra = (version: number, sql = `CREATE TABLE t${version} (id INTEGER)`): Migration => ({
  version,
  name: `00${version}`,
  sql,
});

describe('migrate', () => {
  it('applies every migration on a fresh database', async () => {
    const { db, state } = fakeDatabase();
    expect(await migrate(db)).toBe(migrations.length);
    expect(state.version).toBe(migrations.length);
    expect(state.executed[0]).toContain('CREATE TABLE local_settings');
    expect(state.executed[0]).toContain('CREATE TABLE crypto_store');
  });

  it('applies only pending migrations', async () => {
    const { db, state } = fakeDatabase(1);
    expect(await migrate(db, [...migrations, extra(2)])).toBe(2);
    expect(state.executed).toEqual(['CREATE TABLE t2 (id INTEGER)']);
  });

  it('is a no-op when up to date', async () => {
    const { db, state } = fakeDatabase(1);
    expect(await migrate(db)).toBe(1);
    expect(state.executed).toEqual([]);
  });

  it('keeps the previous version when a migration fails', async () => {
    const { db, state } = fakeDatabase(1);
    await expect(migrate(db, [...migrations, extra(2, 'FAIL')])).rejects.toThrow('sql error');
    expect(state.version).toBe(1);
  });

  it('rejects gaps and a database newer than the app', async () => {
    await expect(migrate(fakeDatabase().db, [...migrations, extra(3)])).rejects.toThrow('in order');
    await expect(migrate(fakeDatabase(5).db)).rejects.toThrow('newer than this app');
  });
});
