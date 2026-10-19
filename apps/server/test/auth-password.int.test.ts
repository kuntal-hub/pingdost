/** Password reset by email OTP, and password change. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bearer,
  emailCount,
  json,
  newUser,
  otpFor,
  registeredUser,
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

function forgot(email: string) {
  return server.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', payload: { email } });
}

function login(identifier: string, password: string) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier, password },
  });
}

function me(accessToken: string) {
  return server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) });
}

describe('password reset', () => {
  it('answers the same for unknown addresses and sends nothing', async () => {
    const { email } = newUser();
    expect((await forgot(email)).statusCode).toBe(204);
    expect(await emailCount(email)).toBe(0);
  });

  it('resets with the emailed code and signs out every session', async () => {
    const session = await registeredUser(server);
    const { user } = session;
    expect((await forgot(user.email)).statusCode).toBe(204);
    const otp = await otpFor(user.email, 2); // the verification email came first

    const newPassword = 'a brand new password';
    const reset = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { email: user.email, otp, newPassword },
    });
    expect(reset.statusCode).toBe(204);

    expect(json(await me(session.accessToken))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(json(await login(user.username, user.password))).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect((await login(user.username, newPassword)).statusCode).toBe(200);

    // The code works once.
    const again = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { email: user.email, otp, newPassword: 'yet another password' },
    });
    expect(json(again)).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('does not accept a verification code as a reset code', async () => {
    const user = newUser();
    await server.app.inject({ method: 'POST', url: '/v1/auth/register', payload: user });
    const verificationCode = await otpFor(user.email);
    const reset = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { email: user.email, otp: verificationCode, newPassword: 'a brand new password' },
    });
    expect(json(reset)).toMatchObject({ code: 'OTP_EXPIRED' });
  });
});

describe('password change', () => {
  it('needs the current password, then signs out the other sessions only', async () => {
    const first = await registeredUser(server);
    const { user } = first;
    const second = json<{ tokens: { accessToken: string } }>(
      await login(user.username, user.password),
    ).tokens;

    const wrong = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(second.accessToken),
      payload: { currentPassword: 'not my password', newPassword: 'a brand new password' },
    });
    expect(json(wrong)).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const changed = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(second.accessToken),
      payload: { currentPassword: user.password, newPassword: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await me(second.accessToken)).statusCode).toBe(200);
    expect(json(await me(first.accessToken))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await login(user.username, 'a brand new password')).statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      payload: { currentPassword: 'x', newPassword: 'a brand new password' },
    });
    expect(response.statusCode).toBe(401);
  });
});
