/** Registration and email OTP verification (REQ §6.1). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bearer,
  emailCount,
  json,
  newUser,
  otpFor,
  startTestServer,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

function register(payload: object) {
  return server.app.inject({ method: 'POST', url: '/v1/auth/register', payload });
}

function verify(email: string, otp: string) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/auth/email/verify',
    payload: { email, otp },
  });
}

describe('register + verify', () => {
  it('creates a pending user, emails a code, and verifying it signs the user in', async () => {
    const user = newUser();
    const registered = await register({ ...user, username: user.username.toUpperCase() });
    expect(registered.statusCode).toBe(201);
    const body = json<{ userId: string; status: string }>(registered);
    expect(body.status).toBe('pending_verification');
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await server.mongo.db.collection('users').findOne({ email: user.email });
    expect(stored?.username).toBe(user.username);
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(user.password);

    const otp = await otpFor(user.email);
    const otpDoc = await server.mongo.db.collection('email_otps').findOne({});
    expect(JSON.stringify(otpDoc)).not.toContain(otp);

    const verified = await verify(user.email, otp);
    expect(verified.statusCode).toBe(200);
    const session = json<{ user: { status: string }; tokens: { accessToken: string } }>(verified);
    expect(session.user.status).toBe('active');

    const me = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(session.tokens.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(json(me)).toMatchObject({
      username: user.username,
      email: user.email,
      status: 'active',
    });
  });

  it('rejects taken and reserved usernames, taken emails and invalid input', async () => {
    const user = newUser();
    await register(user);
    await verify(user.email, await otpFor(user.email));

    const sameUsername = await register({ ...newUser(), username: user.username });
    expect(json(sameUsername)).toMatchObject({ status: 409, code: 'USERNAME_TAKEN' });
    const sameEmail = await register({ ...newUser(), email: user.email.toUpperCase() });
    expect(json(sameEmail)).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    const reserved = await register({ ...newUser(), username: 'admin' });
    expect(json(reserved)).toMatchObject({ code: 'USERNAME_RESERVED' });

    const invalid = await register({ username: 'a!', email: 'nope', password: 'short' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['content-type']).toContain('application/problem+json');
    const problem = json<{ code: string; errors: { path: string }[] }>(invalid);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect([...new Set(problem.errors.map((error) => error.path))].sort()).toEqual([
      'body.email',
      'body.password',
      'body.username',
    ]);
    expect(invalid.body).not.toContain('short');
  });

  it('lets the owner of an email start over while the registration is unverified', async () => {
    const user = newUser();
    await register(user);
    server.clock.advance(31_000); // past the resend cooldown
    const again = await register({ ...user, username: newUser().username });
    expect(again.statusCode).toBe(201);
    expect(await server.mongo.db.collection('users').countDocuments({ email: user.email })).toBe(1);
  });
});

describe('OTP rules', () => {
  it('rejects a wrong code and accepts the right one once', async () => {
    const user = newUser();
    await register(user);
    const otp = await otpFor(user.email);
    const wrong = otp === '000000' ? '111111' : '000000';
    expect(json(await verify(user.email, wrong))).toMatchObject({ code: 'OTP_INVALID' });
    expect((await verify(user.email, otp)).statusCode).toBe(200);
    expect(json(await verify(user.email, otp))).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('expires codes after EMAIL_OTP_TTL_SECONDS', async () => {
    const user = newUser();
    await register(user);
    const otp = await otpFor(user.email);
    server.clock.advance(server.config.EMAIL_OTP_TTL_SECONDS * 1000 + 1);
    expect(json(await verify(user.email, otp))).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('deletes the code after EMAIL_OTP_MAX_ATTEMPTS wrong guesses', async () => {
    const user = newUser();
    await register(user);
    const otp = await otpFor(user.email);
    const wrong = otp === '000000' ? '111111' : '000000';
    const max = server.config.EMAIL_OTP_MAX_ATTEMPTS;
    for (let i = 1; i < max; i++) {
      expect(json(await verify(user.email, wrong))).toMatchObject({ code: 'OTP_INVALID' });
    }
    expect(json(await verify(user.email, wrong))).toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    // Even the right code is gone now.
    expect(json(await verify(user.email, otp))).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('enforces the resend cooldown, then replaces the code', async () => {
    const user = newUser();
    await register(user);
    const first = await otpFor(user.email);

    const tooSoon = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/email/resend',
      payload: { email: user.email },
    });
    expect(tooSoon.statusCode).toBe(429);
    expect(json(tooSoon)).toMatchObject({ code: 'OTP_RESEND_COOLDOWN' });
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);

    server.clock.advance(server.config.EMAIL_OTP_RESEND_COOLDOWN_SECONDS * 1000 + 1);
    const resent = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/email/resend',
      payload: { email: user.email },
    });
    expect(resent.statusCode).toBe(204);
    const second = await otpFor(user.email, 2);
    if (second !== first) {
      expect(json(await verify(user.email, first))).toMatchObject({ code: 'OTP_INVALID' });
    }
    expect((await verify(user.email, second)).statusCode).toBe(200);
  });

  it('answers resend for unknown addresses without sending anything', async () => {
    const { email } = newUser();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/email/resend',
      payload: { email },
    });
    expect(response.statusCode).toBe(204);
    expect(await emailCount(email)).toBe(0);
  });
});
