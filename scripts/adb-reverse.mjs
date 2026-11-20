// Dev only: lets every phone or emulator attached over adb reach this PC's dev services at
// 127.0.0.1, whatever network each is on: the API and WebSocket (3000), Metro (8081) and the
// dev TURN relay for calls (3478; ADR 0046, 0047). A phone that is the PC's hotspot has no
// other route for call media. Runs before Metro starts (`pnpm --filter @pingdost/mobile start`);
// it never stops Metro from starting: no adb, no device or a hung adb only print a line.
import { execFileSync } from 'node:child_process';

const PORTS = [3000, 8081, 3478];
/** A wedged adb server never answers; `adb kill-server` fixes it. */
const TIMEOUT_MS = 10_000;

function adb(args) {
  return execFileSync('adb', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
  });
}

function why(error) {
  if (error?.code === 'ENOENT') return 'adb is not on PATH';
  if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
    return `adb did not answer in ${TIMEOUT_MS / 1000} s (try: adb kill-server)`;
  }
  return String(error?.stderr || error).split('\n')[0];
}

let devices = [];
try {
  devices = adb(['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
} catch (error) {
  console.log(`adb-reverse: skipped, ${why(error)}`);
}

for (const serial of devices) {
  try {
    for (const port of PORTS) adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    console.log(`adb-reverse: ${serial} reaches 127.0.0.1:${PORTS.join(', ')} on this PC`);
  } catch (error) {
    console.log(`adb-reverse: ${serial} failed, ${why(error)}`);
  }
}
