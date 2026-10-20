/**
 * Prints a new VAPID key pair for Web Push (ADR 0015, 0020). Put the private key only in the
 * server's `.env`; the public key also goes into `apps/web/.env` as `VITE_WEB_PUSH_PUBLIC_KEY`.
 *
 *   pnpm --filter @pingdost/server vapid-keys
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('# Server (.env at the repo root; the private key is a secret):');
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`);
console.log('WEB_PUSH_SUBJECT=mailto:you@example.com');
console.log('');
console.log('# Web app (apps/web/.env; public):');
console.log(`VITE_WEB_PUSH_PUBLIC_KEY=${publicKey}`);
