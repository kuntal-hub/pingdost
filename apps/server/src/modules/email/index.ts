import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import { createConsoleProvider, type EmailProvider } from './provider';
import { createSmtpProvider } from './smtp';
import { createZeptomailProvider } from './zeptomail';

export { EmailDeliveryError } from './provider';
export type { EmailMessage, EmailProvider } from './provider';
export { otpEmail, type OtpPurpose } from './templates';

/** The provider chosen by `EMAIL_PROVIDER` (config has already checked its settings). */
export function createEmailProvider(
  config: ServerConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): EmailProvider {
  const emailLog = log.child({ component: 'email' });
  switch (config.EMAIL_PROVIDER) {
    case 'console':
      return createConsoleProvider(emailLog, config.EMAIL_CONSOLE_SHOW_CONTENT);
    case 'smtp':
      if (!config.smtp) throw new Error('EMAIL_PROVIDER=smtp needs SMTP_HOST and SMTP_PORT');
      return createSmtpProvider(config.smtp, config.EMAIL_FROM);
    case 'zeptomail':
      if (!config.zeptomail) throw new Error('EMAIL_PROVIDER=zeptomail needs EMAIL_API_KEY');
      return createZeptomailProvider(config.zeptomail, config.EMAIL_FROM, emailLog, fetchFn);
  }
}
