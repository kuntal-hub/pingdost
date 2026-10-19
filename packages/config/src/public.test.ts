import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import * as publicModule from './public';
import { loadPublicConfig } from './public';
import { SERVER_SECRET_KEYS } from './server';

describe('loadPublicConfig', () => {
  it('reads EXPO_PUBLIC_* and VITE_* variables', () => {
    const urls = { apiUrl: 'https://api.pingdost.com', wsUrl: 'wss://api.pingdost.com/ws' };
    expect(
      loadPublicConfig(
        { EXPO_PUBLIC_API_URL: urls.apiUrl, EXPO_PUBLIC_WS_URL: urls.wsUrl },
        'EXPO_PUBLIC_',
      ),
    ).toEqual(urls);
    expect(
      loadPublicConfig({ VITE_API_URL: urls.apiUrl, VITE_WS_URL: urls.wsUrl, PROD: true }, 'VITE_'),
    ).toEqual(urls);
  });

  it('reads the optional Google web client ID', () => {
    const googleWebClientId = '1234-abc.apps.googleusercontent.com';
    expect(
      loadPublicConfig(
        {
          EXPO_PUBLIC_API_URL: 'http://192.168.1.10:3000',
          EXPO_PUBLIC_WS_URL: 'ws://192.168.1.10:3000/ws',
          EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: googleWebClientId,
        },
        'EXPO_PUBLIC_',
      ),
    ).toMatchObject({ googleWebClientId });
    expect(() =>
      loadPublicConfig(
        {
          EXPO_PUBLIC_API_URL: 'http://192.168.1.10:3000',
          EXPO_PUBLIC_WS_URL: 'ws://192.168.1.10:3000/ws',
          EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'not-a-client-id',
        },
        'EXPO_PUBLIC_',
      ),
    ).toThrow(/EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: must end with/);
  });

  it('reports missing and invalid variables by their prefixed names', () => {
    let error: unknown;
    try {
      loadPublicConfig(
        { VITE_API_URL: 'http://localhost:3000', EXPO_PUBLIC_WS_URL: 'http://wrong' },
        'EXPO_PUBLIC_',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      'EXPO_PUBLIC_API_URL: is required',
      'EXPO_PUBLIC_WS_URL: must be a ws(s) URL',
    ]);
  });
});

describe('public / secret separation (ARCHITECTURE A10)', () => {
  it('never returns server secrets, even when they are present or prefixed', () => {
    const env: Record<string, string> = {
      EXPO_PUBLIC_API_URL: 'http://192.168.1.10:3000',
      EXPO_PUBLIC_WS_URL: 'ws://192.168.1.10:3000/ws',
    };
    for (const key of SERVER_SECRET_KEYS) {
      env[key] = `secret-value-${key}`;
      env[`EXPO_PUBLIC_${key}`] = `secret-value-${key}`;
    }
    const config = loadPublicConfig(env, 'EXPO_PUBLIC_');
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'wsUrl']);
    expect(JSON.stringify(config)).not.toContain('secret-value');
  });

  it('exports nothing that names a server secret', () => {
    const exported = Object.values(publicModule)
      .map((value) => (typeof value === 'function' ? value.toString() : JSON.stringify(value)))
      .join('\n');
    for (const key of SERVER_SECRET_KEYS) expect(exported).not.toContain(key);
  });

  it('imports only zod and ./errors (never ./server)', () => {
    const importsOf = (file: string) =>
      [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from '([^']+)'/g)].map(
        (match) => match[1],
      );
    expect(importsOf('./public.ts').sort()).toEqual(['./errors', 'zod']);
    expect(importsOf('./errors.ts')).toEqual(['zod']);
  });
});
