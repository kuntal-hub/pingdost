/**
 * pino logger with redaction (ARCHITECTURE A2, A10). Two layers:
 * - every plain object logged has fields with sensitive names replaced, at any depth
 *   (passwords, OTPs, tokens, secrets, `*Key`, ciphertext, payloads, SDP, email addresses);
 * - request logs carry only the method, path (no query string) and status, never headers,
 *   bodies or client IPs.
 */
import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

export const REDACTED = '[redacted]';

/** Field names whose values never reach a log line. */
const SENSITIVE_KEY =
  /(password|token|secret|key)$|^(otp|code|ciphertext|payload|sdp|authorization|cookie|email|to)$/i;

const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A copy of `value` with sensitive fields replaced. Only plain objects and arrays are walked. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(field, depth + 1);
  }
  return result;
}

interface RequestLike {
  id?: unknown;
  method?: string;
  url?: string;
}

interface ReplyLike {
  statusCode?: number;
}

export interface LoggerSettings {
  level: string;
  /** Human-readable output (development only). */
  pretty?: boolean;
  /** Where to write; default stdout. Tests pass a capturing stream. */
  destination?: DestinationStream;
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { pid: process.pid },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: REDACTED,
    },
    formatters: {
      log: (object) => scrub(object) as Record<string, unknown>,
    },
    serializers: {
      req: (req: RequestLike) => ({
        id: req.id,
        method: req.method,
        path: req.url?.split('?', 1)[0],
      }),
      res: (res: ReplyLike) => ({ statusCode: res.statusCode }),
      err: stdSerializers.err,
    },
  };
}

export function createLogger(settings: LoggerSettings): Logger {
  const options = loggerOptions(settings.level);
  if (settings.destination) return pino(options, settings.destination);
  if (settings.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } },
    });
  }
  return pino(options);
}
