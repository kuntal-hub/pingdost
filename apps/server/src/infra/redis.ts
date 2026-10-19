/**
 * Redis (ARCHITECTURE A2): one `REDIS_URL` for Upstash or Valkey, used only by the delivery
 * mailbox from Phase 8. The client is created on first use, and every command is counted so
 * the free-tier budget (500K commands/month on Upstash) can be watched.
 */
import { Redis } from 'ioredis';

export interface RedisHandle {
  /** Whether anything has used Redis yet (`/readyz` checks it only then). */
  readonly used: boolean;
  client(): Redis;
  commandCount(): number;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedisHandle(url: string): RedisHandle {
  let redis: Redis | undefined;
  let commands = 0;

  function client(): Redis {
    if (!redis) {
      const created = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
        commandTimeout: 5_000,
      });
      const send = created.sendCommand.bind(created);
      created.sendCommand = (...args: Parameters<Redis['sendCommand']>) => {
        commands++;
        return send(...args);
      };
      // Errors surface on the commands themselves; this listener only keeps them off the
      // process-level 'error' event.
      created.on('error', () => undefined);
      redis = created;
    }
    return redis;
  }

  return {
    get used() {
      return redis !== undefined;
    },
    client,
    commandCount: () => commands,
    async ping(timeoutMs = 2_000) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          client()
            .ping()
            .then(
              (reply) => reply === 'PONG',
              () => false,
            ),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (redis) await redis.quit().catch(() => redis?.disconnect());
    },
  };
}
