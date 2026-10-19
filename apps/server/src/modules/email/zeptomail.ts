/**
 * ZeptoMail HTTP API (checked 2026-10-19: https://www.zoho.com/zeptomail/help/api/email-sending.html).
 * `POST {ZEPTOMAIL_API_URL}` with `Authorization: Zoho-enczapikey <key>` and a JSON body of
 * `from`, `to[].email_address`, `subject`, `htmlbody` and `textbody`. The host depends on the
 * account's region, so it is configurable.
 */
import type { Logger } from 'pino';

import { EmailDeliveryError, parseSender, type EmailProvider } from './provider';

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export interface ZeptomailSettings {
  apiKey: string;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createZeptomailProvider(
  settings: ZeptomailSettings,
  from: string,
  log: Logger,
  fetchFn: typeof fetch,
): EmailProvider {
  const sender = parseSender(from);
  return {
    name: 'zeptomail',
    async send(message) {
      const body = JSON.stringify({
        from: sender,
        to: [{ email_address: { address: message.to } }],
        subject: message.subject,
        htmlbody: message.html,
        textbody: message.text,
      });
      for (let attempt = 1; ; attempt++) {
        let status = 0;
        try {
          const response = await fetchFn(settings.url, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: `Zoho-enczapikey ${settings.apiKey}`,
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          status = response.status;
          await response.body?.cancel();
          if (response.ok) return;
        } catch {
          // Network error or timeout: retried below.
        }
        // 4xx (bad key, unverified sender, malformed request) will not succeed on retry.
        const retryable = status === 0 || status === 429 || status >= 500;
        if (!retryable || attempt >= ATTEMPTS) {
          throw new EmailDeliveryError(`ZeptoMail did not accept the message (HTTP ${status})`);
        }
        log.warn({ status, attempt }, 'ZeptoMail send failed; retrying');
        await sleep(500 * 2 ** (attempt - 1));
      }
    },
    close: () => Promise.resolve(),
  };
}
