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
import { VitePWA } from 'vite-plugin-pwa';

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
  /** Where signed attachment URLs point when the store is not the API itself (S3, ADR 0017). */
  storageUrl?: string | undefined;
  dev: boolean;
}): string {
  const nonce = options.dev ? ` 'nonce-${DEV_NONCE}'` : '';
  const connect = [
    "'self'",
    originOf(options.apiUrl),
    originOf(options.wsUrl),
    originOf(options.storageUrl),
    // Vite's hot-reload socket.
    ...(options.dev ? ['ws://localhost:5173', 'ws://127.0.0.1:5173'] : []),
  ].filter(Boolean);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${nonce}`,
    `style-src 'self'${nonce}`,
    // Profile pictures are public Cloudinary URLs (ADR 0008); group pictures are `data:`.
    "img-src 'self' data: blob: https://res.cloudinary.com",
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
        contentSecurityPolicy({
          apiUrl: env.VITE_API_URL,
          wsUrl: env.VITE_WS_URL,
          storageUrl: env.VITE_STORAGE_URL,
          dev,
        }),
      ),
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const dev = command === 'serve';
  return {
    plugins: [
      react(),
      tailwindcss(),
      csp(env, dev),
      // Install, the offline shell and Web Push (ADR 0020). The service worker exists only in
      // builds (`build` + `preview`), never in `vite dev`.
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src/sw',
        filename: 'sw.ts',
        injectRegister: false,
        manifest: {
          name: 'PingDost',
          short_name: 'PingDost',
          description: 'Private, end-to-end encrypted messages, linked to your phone.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#0B1220',
          theme_color: '#0B7A64',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        injectManifest: {
          rollupFormat: 'iife',
          globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
          // The crypto module is about 1.1 MB.
          maximumFileSizeToCacheInBytes: 4 * 1_048_576,
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    html: dev ? { cspNonce: DEV_NONCE } : {},
    server: { port: 5173, strictPort: true },
    // The same origin as `vite dev`, so the server's WEB_ORIGIN fits both.
    preview: { port: 5173, strictPort: true },
    build: { target: 'es2022', sourcemap: true },
  };
});
