/**
 * API entrypoint. With `RUN_WORKER_IN_PROCESS=true` it also runs the background jobs
 * (otherwise run `worker.ts` as a second process).
 */
import { buildApp, INDEXES } from './app';
import { createRedisHandle } from './infra/redis';
import { onShutdown } from './infra/shutdown';
import { connectDatabase, loadConfigOrExit, redactConfig, startupLogger } from './infra/startup';
import { startScheduler } from './jobs';
import { createEmailProvider } from './modules/email';

const config = loadConfigOrExit();
const logger = startupLogger(config, 'api');
logger.debug({ config: redactConfig(config) }, 'configuration');

try {
  const mongo = await connectDatabase(config, INDEXES);
  const redis = createRedisHandle(config.REDIS_URL);
  const email = createEmailProvider(config, logger);
  const app = await buildApp(config, { logger, mongo, redis, email });
  const scheduler = config.RUN_WORKER_IN_PROCESS
    ? startScheduler({ config, mongo, redis, logger })
    : undefined;

  onShutdown(logger, async () => {
    await app.close();
    await scheduler?.stop();
    await email.close();
    await redis.close();
    await mongo.close();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  process.exit(1);
}
