import { createTransport } from 'nodemailer';

import { EmailDeliveryError, type EmailProvider } from './provider';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string } | undefined;
}

/** SMTP via nodemailer: Mailpit in development, Brevo or Zoho in production. */
export function createSmtpProvider(settings: SmtpSettings, from: string): EmailProvider {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.auth ? { auth: settings.auth } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    name: 'smtp',
    async send(message) {
      try {
        await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        throw new EmailDeliveryError('SMTP server did not accept the message', { cause: error });
      }
    },
    close() {
      transport.close();
      return Promise.resolve();
    },
  };
}
