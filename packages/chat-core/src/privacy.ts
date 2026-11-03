/**
 * The in-app privacy explainer, the same on the phone and the web (Phase 27; REQ §1, §5.4;
 * ARCHITECTURE A10). Keep it in step with docs/legal/privacy-policy.md. The wording rules
 * (`privacy.test.ts`): say "no permanent server-side chat history", never that no data
 * reaches our servers, and name the limits honestly.
 */
export interface PrivacySection {
  title: string;
  body: string;
}

export const PRIVACY_EXPLAINER: readonly PrivacySection[] = [
  {
    title: 'Your chats live on your devices',
    body: 'PingDost keeps no permanent server-side chat history. Your conversations are stored on your own devices, in an encrypted database.',
  },
  {
    title: 'What passes through our servers',
    body: 'Messages, files and calls are end-to-end encrypted before they leave your device; we cannot read them. When the person you write to is offline, our server holds the encrypted message or file to deliver it, and deletes it once their device confirms it arrived, or after 14 days at most.',
  },
  {
    title: 'What our server can see',
    body: 'Your account (username, verified email, a password hash if you use a password), your settings, and your devices with their public keys. To deliver messages it also sees which account and device sends to which, when, and how large each message is. Sign-in and device events are kept for 90 days with a hashed IP address. Private keys never leave your devices.',
  },
  {
    title: 'Without a backup, history cannot come back',
    body: 'If you lose every device and have no backup, your messages are gone: we never had them, so we cannot restore them. Make a backup in Settings → Backup and keep the recovery phrase safe.',
  },
  {
    title: 'Linked browsers are weaker than your phone',
    body: "A linked browser keeps an encrypted copy of recent history in the browser's storage. Anyone who can use that browser profile, or malware in it, may be able to read it. Unlink browsers you no longer use.",
  },
  {
    title: 'Nearby and relaying (off unless you turn them on)',
    body: "With Nearby messaging on, PingDost phones in Bluetooth range can see that a PingDost phone is near and, once connected, this device's public key, which does not change. With Nearby relay on, your phone carries other people's encrypted messages; relaying phones see routing codes, times and sizes, never the content.",
  },
  {
    title: 'Calls and notifications',
    body: 'Calls are end-to-end encrypted. When a direct connection is not possible they pass through our relay server, which sees both IP addresses and how much data flows. Push notifications carry no message content: Google (on Android), Apple (on iPhone) or your browser’s push service only learns that PingDost woke your device, or on an iPhone that a call is coming.',
  },
  {
    title: 'What deletion cannot reach',
    body: "Deleting a message cannot erase screenshots, exports, notifications already shown, or copies on other people's devices. Encrypted copies awaiting deletion can remain for a short time in our server's logs and our host's backups; they stay unreadable to us.",
  },
  {
    title: 'No ads, no analytics',
    body: 'PingDost has no ads, no analytics and no crash-reporting SDK. The code is open source (AGPL-3.0).',
  },
];
