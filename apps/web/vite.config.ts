/**
 * The PingDost web app (ARCHITECTURE A7, ADR 0019). The page carries a strict Content Security
 * Policy built from the configured API and WebSocket origins: scripts and styles from this
 * origin only (plus WebAssembly compilation for the crypto module), no inline code, no plugins,
 * no framing of other sites. In `vite dev` a fixed nonce admits the tags Vite itself injects;
 * production (Phase 20) sends the same policy as a header, without a nonce.
 */
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** Dev only: Vite's injected scripts and styles carry it. Never used in a build. */
const DEV_NONCE = 'pingdost-dev-nonce';

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function contentSecurityPolicy(options: {
  apiUrl: string | undefined;
  wsUrl: string | undefined;
  dev: boolean;
}): string {
  const nonce = options.dev ? ` 'nonce-${DEV_NONCE}'` : '';
  const connect = [
    "'self'",
    originOf(options.apiUrl),
    originOf(options.wsUrl),
    // Vite's hot-reload socket.
    ...(options.dev ? ['ws://localhost:5173', 'ws://127.0.0.1:5173'] : []),
  ].filter(Boolean);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${nonce}`,
    `style-src 'self'${nonce}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function csp(env: Record<string, string>, dev: boolean): Plugin {
  return {
    name: 'pingdost-csp',
    transformIndexHtml: (html) =>
      html.replace(
        '%PINGDOST_CSP%',
        contentSecurityPolicy({ apiUrl: env.VITE_API_URL, wsUrl: env.VITE_WS_URL, dev }),
      ),
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const dev = command === 'serve';
  return {
    plugins: [react(), tailwindcss(), csp(env, dev)],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    html: dev ? { cspNonce: DEV_NONCE } : {},
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { target: 'es2022', sourcemap: true },
  };
});
