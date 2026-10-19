import { describe, expect, it, vi } from 'vitest';

import { EmailDeliveryError, parseSender } from './provider';
import { otpEmail } from './templates';
import { createZeptomailProvider } from './zeptomail';
import { createLogger } from '../../infra/logger';

const log = createLogger({ level: 'silent' });
const message = {
  to: 'someone@example.com',
  subject: 'Hi',
  text: 'code 123456',
  html: '<p>123456</p>',
};

describe('otpEmail', () => {
  it('renders the code, purpose and expiry in text and HTML', () => {
    const email = otpEmail('password_reset', '042917', 600);
    expect(email.subject).toContain('password reset');
    expect(email.text).toContain('042917');
    expect(email.text).toContain('10 minutes');
    expect(email.html).toContain('042917');
  });
});

describe('parseSender', () => {
  it('splits a display name from the address', () => {
    expect(parseSender('PingDost <no-reply@pingdost.com>')).toEqual({
      name: 'PingDost',
      address: 'no-reply@pingdost.com',
    });
    expect(parseSender('no-reply@pingdost.com')).toEqual({ address: 'no-reply@pingdost.com' });
  });
});

describe('ZeptoMail provider', () => {
  const settings = { apiKey: 'zepto-key', url: 'https://api.zeptomail.eu/v1.1/email' };

  it('posts the documented request', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 201 })));
    const provider = createZeptomailProvider(
      settings,
      'PingDost <no-reply@pingdost.com>',
      log,
      fetchFn,
    );
    await provider.send(message);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.zeptomail.eu/v1.1/email');
    expect(new Headers(init?.headers).get('authorization')).toBe('Zoho-enczapikey zepto-key');
    expect(JSON.parse(init?.body as string)).toEqual({
      from: { name: 'PingDost', address: 'no-reply@pingdost.com' },
      to: [{ email_address: { address: 'someone@example.com' } }],
      subject: 'Hi',
      htmlbody: '<p>123456</p>',
      textbody: 'code 123456',
    });
  });

  it('retries server errors but not client errors, and never puts content in the error', async () => {
    const flaky = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await createZeptomailProvider(settings, 'a@b.c', log, flaky).send(message);
    expect(flaky).toHaveBeenCalledTimes(2);

    const rejected = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 400 })));
    const error = await createZeptomailProvider(settings, 'a@b.c', log, rejected)
      .send(message)
      .catch((reason: unknown) => reason);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(String(error)).not.toContain('123456');
    expect(String(error)).not.toContain('someone@example.com');
  });
});
