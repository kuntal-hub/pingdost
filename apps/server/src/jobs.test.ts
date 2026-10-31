import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { HEARTBEAT_INTERVAL_MS, heartbeatJob } from './jobs';

describe('heartbeat job', () => {
  it('pings the URL each run and never throws when the monitor is down', async () => {
    const hits: string[] = [];
    const monitor = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.statusCode = hits.length === 1 ? 200 : 500;
      response.end();
    });
    await new Promise<void>((resolve) => monitor.listen(0, '127.0.0.1', resolve));
    const { port } = monitor.address() as AddressInfo;
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
    const job = heartbeatJob(`http://127.0.0.1:${port}/ping/check-id`, log);
    expect(job.intervalMs).toBe(HEARTBEAT_INTERVAL_MS);

    await job.run(new AbortController().signal);
    await job.run(new AbortController().signal);
    await new Promise<void>((resolve) => monitor.close(() => resolve()));
    await job.run(new AbortController().signal);

    expect(hits).toEqual(['/ping/check-id', '/ping/check-id']);
    expect(lines).toHaveLength(2);
    // The URL (it holds the check ID) is never logged.
    expect(lines.join('')).not.toContain('check-id');
  });
});
