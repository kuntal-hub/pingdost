import { describe, expect, it } from 'vitest';

import { PingdostDb } from './db';
import {
  decryptBytes,
  decryptRecord,
  encryptBytes,
  encryptRecord,
  SealedRecords,
  vaultKey,
} from './vault';

let counter = 0;
const freshDb = () => new PingdostDb(`pingdost-test-${++counter}`);

describe('the browser vault (REQ §7.5)', () => {
  it('keeps one non-extractable key per browser, across reopening', async () => {
    const db = freshDb();
    const key = await vaultKey(db);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    // Two callers racing still agree on one key.
    const [a, b] = await Promise.all([vaultKey(db), vaultKey(db)]);
    const sealed = await encryptRecord(a, { x: 1 }, 'r');
    expect(await decryptRecord(b, sealed, 'r')).toEqual({ x: 1 });

    db.close();
    const again = new PingdostDb(db.name);
    expect(await decryptRecord(await vaultKey(again), sealed, 'r')).toEqual({ x: 1 });
    again.close();
  });

  it('round-trips values and refuses altered or moved ones', async () => {
    const key = await vaultKey(freshDb());
    const sealed = await encryptRecord(key, { pickle: 'secret', n: 2 }, 'account');
    expect(new TextDecoder().decode(sealed.data)).not.toContain('secret');
    expect(sealed.iv).toHaveLength(12);
    expect(await decryptRecord(key, sealed, 'account')).toEqual({ pickle: 'secret', n: 2 });

    const altered = { iv: sealed.iv, data: Uint8Array.from(sealed.data) };
    altered.data[0]! ^= 1;
    await expect(decryptRecord(key, altered, 'account')).rejects.toThrow();
    // Bound to its record: the same bytes under another name do not open.
    await expect(decryptRecord(key, sealed, 'session')).rejects.toThrow();
    // A fresh IV every time.
    const again = await encryptRecord(key, { pickle: 'secret', n: 2 }, 'account');
    expect(again.iv).not.toEqual(sealed.iv);

    const bytes = await encryptBytes(key, Uint8Array.of(1, 2, 3), 'b');
    expect(await decryptBytes(key, bytes, 'b')).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('stores sealed records by name', async () => {
    const db = freshDb();
    const records = new SealedRecords(db, await vaultKey(db));
    await records.put('device', { deviceId: 'd1' });
    expect(await records.get('device')).toEqual({ deviceId: 'd1' });
    const raw = await db.records.get('device');
    expect(new TextDecoder().decode(raw!.data)).not.toContain('d1');
    await records.delete('device');
    expect(await records.get('device')).toBeUndefined();
  });
});
