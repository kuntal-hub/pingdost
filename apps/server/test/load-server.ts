/**
 * Dev-only load harness (Phase 27, k6/README.md): the real API and jobs, as `src/main.ts`
 * runs them, but with the test suite's relaxed per-IP route limits (one machine plays every
 * client) and its own database, printing the process's memory and CPU every 10 s as
 * `LOAD_STATS {...}`. Never deployed: production keeps DEFAULT_ROUTE_LIMITS.
 *
 *   pnpm --filter @pingdost/server exec tsx --env-file-if-exists=../../.env test/load-server.ts
 */
import { RELAXED_LIMITS } from './helpers';
import { buildApp, createAppMetrics, INDEXES } from '../src/app';
import { createRedisHandle } from '../src/infra/redis';
import { onShutdown } from '../src/infra/shutdown';
import { connectDatabase, loadConfigOrExit, startupLogger } from '../src/infra/startup';
import { startScheduler } from '../src/jobs';
import { createEmailProvider } from '../src/modules/email';

// Its own database, whatever the .env says (LOAD_MONGODB_URI overrides).
process.env.MONGODB_URI =
  process.env.LOAD_MONGODB_URI ?? 'mongodb://localhost:27017/pingdost_load?replicaSet=rs0';
const config = loadConfigOrExit();
const logger = startupLogger(config, 'load');
const mongo = await connectDatabase(config, INDEXES);
const redis = createRedisHandle(config.REDIS_URL);
const email = createEmailProvider(config, logger);
const metrics = createAppMetrics(redis, mongo);
const app = await buildApp(config, {
  logger,
  mongo,
  redis,
  email,
  metrics,
  routeLimits: RELAXED_LIMITS,
});
const scheduler = startScheduler({ config, mongo, redis, logger, metrics });

const startedAt = Date.now();
let lastCpu = process.cpuUsage();
let lastAt = startedAt;
const timer = setInterval(() => {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage(lastCpu);
  const now = Date.now();
  // One core = 100 %: the share of one CPU this process used in the last interval.
  const cpuPercent = Math.round(((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100);
  lastCpu = process.cpuUsage();
  lastAt = now;
  app.server.getConnections((_error, sockets) => {
    console.log(
      `LOAD_STATS ${JSON.stringify({
        t: Math.round((now - startedAt) / 1000),
        sockets,
        rssMiB: Math.round(memory.rss / 1048576),
        heapMiB: Math.round(memory.heapUsed / 1048576),
        cpuPercent,
      })}`,
    );
  });
}, 10_000);

onShutdown(logger, async () => {
  clearInterval(timer);
  await app.close();
  await scheduler.stop();
  await email.close();
  await redis.close();
  await mongo.close();
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
logger.warn({ port: config.PORT }, 'LOAD HARNESS: relaxed route limits; dev only');
