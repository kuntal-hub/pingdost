/**
 * Outgoing email (ARCHITECTURE A2): one `EmailProvider` interface with `console` (dev only),
 * `smtp` (Mailpit, Brevo, Zoho) and `zeptomail` (HTTP API) adapters, chosen by
 * `EMAIL_PROVIDER`. Logs never contain recipients or content, except the console provider's
 * content when `EMAIL_CONSOLE_SHOW_CONTENT=true` (development only; config forbids it in
 * production).
 */
import type { Logger } from 'pino';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface EmailMessage extends EmailContent {
  to: string;
}

export interface EmailProvider {
  readonly name: 'console' | 'smtp' | 'zeptomail';
  /** Rejects with `EmailDeliveryError` when the provider does not accept the message. */
  send(message: EmailMessage): Promise<void>;
  close(): Promise<void>;
}

/** The provider did not accept a message. The message never includes content or recipients. */
export class EmailDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailDeliveryError';
  }
}

/** Splits `Name <address>` (or a bare address). */
export function parseSender(from: string): { name?: string; address: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { address: from.trim() };
  const name = match[1]?.replace(/^"|"$/g, '');
  return { ...(name ? { name } : {}), address: match[2] ?? '' };
}

export function createConsoleProvider(log: Logger, showContent: boolean): EmailProvider {
  return {
    name: 'console',
    send(message) {
      if (showContent) {
        log.info({ subject: message.subject, body: message.text }, 'email (console provider)');
      } else {
        log.info({ subject: message.subject }, 'email (console provider; content hidden)');
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}
