/** Worker entrypoint: background jobs only, for deployments with `RUN_WORKER_IN_PROCESS=false`. */
import { createAppMetrics, INDEXES } from './app';
import { createRedisHandle } from './infra/redis';
import { onShutdown } from './infra/shutdown';
import { connectDatabase, loadConfigOrExit, startupLogger } from './infra/startup';
import { startScheduler } from './jobs';

const config = loadConfigOrExit();
const logger = startupLogger(config, 'worker');

try {
  const mongo = await connectDatabase(config, INDEXES);
  const redis = createRedisHandle(config.REDIS_URL);
  // A separate worker has no HTTP server: its job metrics show only in the logs (Phase 20
  // decides whether the worker gets its own metrics port).
  const metrics = createAppMetrics(redis, mongo);
  const scheduler = startScheduler({ config, mongo, redis, logger, metrics });

  onShutdown(logger, async () => {
    await scheduler.stop();
    await redis.close();
    await mongo.close();
  });
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  process.exit(1);
}
