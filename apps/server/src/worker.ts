/** Worker entrypoint: background jobs only, for deployments with `RUN_WORKER_IN_PROCESS=false`. */
import { INDEXES } from './app';
import { createRedisHandle } from './infra/redis';
import { onShutdown } from './infra/shutdown';
import { connectDatabase, loadConfigOrExit, startupLogger } from './infra/startup';
import { startScheduler } from './jobs';

const config = loadConfigOrExit();
const logger = startupLogger(config, 'worker');

try {
  const mongo = await connectDatabase(config, INDEXES);
  const redis = createRedisHandle(config.REDIS_URL);
  const scheduler = startScheduler({ config, mongo, redis, logger });

  onShutdown(logger, async () => {
    await scheduler.stop();
    await redis.close();
    await mongo.close();
  });
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  process.exit(1);
}
