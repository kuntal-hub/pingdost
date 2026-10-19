import type { Logger } from 'pino';

/**
 * Runs `close` once on SIGINT/SIGTERM, then exits. A second signal or a close that takes
 * longer than `timeoutMs` exits immediately with an error code.
 */
export function onShutdown(log: Logger, close: () => Promise<void>, timeoutMs = 10_000): void {
  let closing = false;
  const handle = (signal: NodeJS.Signals) => {
    if (closing) {
      log.warn({ signal }, 'second signal; exiting now');
      process.exit(1);
    }
    closing = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      log.error('shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}
