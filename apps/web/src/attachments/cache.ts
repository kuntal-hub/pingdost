// This browser's attachment cache (REQ §14.2, ADR 0021): files kept as their own ciphertext in
// IndexedDB (`@pingdost/web-store` FileCache), least recently used first out. The two limits
// are per-browser conveniences in localStorage: the cache size, and how large a file this
// browser fetches from the phone over the relay.
import { BYTES_PER_MB, DEFAULT_LIMITS } from '@pingdost/config/public';
import { database, FileCache, type PingdostDb } from '@pingdost/web-store';

let cached: { db: PingdostDb; cache: FileCache } | undefined;

/** The cache on the current database (a new one after unlinking). */
export function fileCache(): FileCache {
  const db = database();
  if (cached?.db !== db) cached = { db, cache: new FileCache(db) };
  return cached.cache;
}

export const CACHE_LIMITS_MB = [100, 250, 500, 1_000, 2_000] as const;
export const PHONE_FILE_LIMITS_MB = [10, 25, 50, 100] as const;

const CACHE_KEY = 'pingdost.cacheLimitMb';
const PHONE_KEY = 'pingdost.phoneFileLimitMb';
const DEFAULT_CACHE_MB = 500;
const DEFAULT_PHONE_MB = DEFAULT_LIMITS.syncFileMaxBytes / BYTES_PER_MB;

function readMb(key: string, allowed: readonly number[], fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeMb(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode or blocked storage: the default stays.
  }
}

export const cacheLimitMb = () => readMb(CACHE_KEY, CACHE_LIMITS_MB, DEFAULT_CACHE_MB);
export const setCacheLimitMb = (mb: number) => writeMb(CACHE_KEY, mb);
export const phoneFileLimitMb = () => readMb(PHONE_KEY, PHONE_FILE_LIMITS_MB, DEFAULT_PHONE_MB);
export const setPhoneFileLimitMb = (mb: number) => writeMb(PHONE_KEY, mb);
