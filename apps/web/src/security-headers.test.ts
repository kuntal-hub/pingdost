/**
 * The production page policy and Cloudflare Pages headers (Phase 27 web audit). A change that
 * loosens them must change this test too.
 */
import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, pagesHeaders } from '../vite.config';

const env = {
  VITE_API_URL: 'https://api.pingdost.com',
  VITE_WS_URL: 'wss://api.pingdost.com/v1/ws',
};

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe('content security policy (production)', () => {
  const policy = contentSecurityPolicy({
    apiUrl: env.VITE_API_URL,
    wsUrl: env.VITE_WS_URL,
    dev: false,
  });
  const parsed = directives(policy);

  it('allows no inline code, no eval, no nonce and no plugins', () => {
    // 'wasm-unsafe-eval' allows WebAssembly compilation only (the crypto module), not eval().
    expect(policy).not.toMatch(
      /'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|nonce-|strict-dynamic/,
    );
    expect(parsed.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(parsed.get('style-src')).toEqual(["'self'"]);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'none'"]);
    expect(parsed.get('default-src')).toEqual(["'self'"]);
  });

  it('connects only to this origin and the configured API', () => {
    expect(parsed.get('connect-src')).toEqual([
      "'self'",
      'https://api.pingdost.com',
      'wss://api.pingdost.com',
    ]);
    expect(policy).not.toContain('localhost');
  });
});

describe('Cloudflare Pages headers', () => {
  const headers = pagesHeaders(env);

  it('forbids framing and sniffing, sends HSTS and no referrer', () => {
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('Strict-Transport-Security: max-age=31536000');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
  });

  it('limits powerful features to calls on this origin', () => {
    expect(headers).toMatch(
      /Permissions-Policy: camera=\(self\), microphone=\(self\), geolocation=\(\)/,
    );
  });

  it('never caches the service worker', () => {
    expect(headers).toMatch(/\/sw\.js\n {2}Cache-Control: no-cache/);
  });
});
