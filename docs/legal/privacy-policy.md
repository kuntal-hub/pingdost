# PingDost Privacy Policy

> **Draft for review (Phase 27).** Fill in the bracketed fields and have it read by someone qualified in the law of your country before publishing. It describes the software as built on 2026-11-02 (Android and web; iOS is not available yet). Keep it in step with `apps/*/…/privacy` screens and the Play Data Safety answers (`docs/release/play-data-safety.md`).

**Who we are:** PingDost is operated by **[operator name / legal entity]**, **[address]**. Contact: **[privacy contact email]**. Last updated: **[date of publishing]**.

## The short version
- Your messages, photos, files and calls are **end-to-end encrypted**. We cannot read them.
- **We keep no permanent server-side chat history.** Your conversation history lives on your devices.
- To reach people who are offline, encrypted messages and files wait on our server **temporarily**, and are deleted when they are delivered, or after **14 days** at most.
- Our server does see some **metadata**: who sends to whom and when, and how big things are. We keep as little as we can, for as short as we can, and we list all of it below.
- If you lose your phone and have **no backup** and no other linked device, **your history cannot be recovered**. We cannot restore it, because we never had it.

## 1. What stays on your devices
- Your messages, attachments, call history and contacts' safety numbers, in an encrypted database on your phone (and, if you link one, in your browser).
- Your private encryption keys. They never leave your device, except inside a backup file you create, encrypted with your recovery phrase.
- **Browser storage is weaker than your phone.** A linked browser keeps an encrypted copy of recent history. Anyone who controls that browser profile (or malware in it) may be able to read it. Unlink browsers you no longer use (Settings → Linked devices).

## 2. What our server stores, and for how long

| Data | Why | How long |
|---|---|---|
| Account: username, email address, password hash (if you use a password), Google account ID (if you sign in with Google), display name, privacy settings, profile picture link | To run your account | Until you delete your account |
| Devices: device ID, type (Android/web), name, public keys, linked/revoked state | So others can encrypt to your devices, and you can manage them | While your account exists; a removed device is kept as "revoked" (so it cannot come back) and its one-time keys are deleted |
| Sessions (sign-in tokens, stored hashed) | Keeping you signed in | 30 days after last use |
| Encrypted messages waiting for an offline device | Delivery | Until the device confirms delivery; at most **14 days** from sending |
| Encrypted attachments waiting for download, plus which devices may download them and their size | Delivery | Until every recipient device confirms; at most **14 days** |
| Email codes (stored hashed) | Verifying your email, password reset | Minutes |
| Security events: sign-ins, device changes, failed logins, with a **hashed** IP address | Protecting accounts, abuse prevention | **90 days** |
| Groups: members and roles (not messages or names, which are encrypted) | Routing group messages to members only | While the group exists |
| Blocks | Not delivering messages from people you blocked | Until you unblock |
| Abuse reports you send, with only the messages you chose to attach | Handling abuse | **90 days** |
| Push tokens (Firebase on Android, Apple Push Notification service on iPhone, Web Push in browsers) | Waking your device when something arrives | Until replaced or the device is removed |

**Metadata our server can see while delivering:** which account and device sends to which device, when, how large each item is, whether a call invite went to an offline device (kept in memory for 15 seconds), your IP address while connected (not stored in logs; hashed in security events), and whether you are online (shared with contacts only if you allow it, and never stored).

**We do not store:** message text, decrypted attachments, conversation lists, a searchable history, read or delivery receipts, typing indicators, call recordings, call content or a permanent call log.

## 3. Deletion
- When your device confirms it received a message or file, the server deletes its copy. Undelivered items are deleted after 14 days.
- Deleting a message "for everyone" asks your contacts' apps to delete it. It cannot erase screenshots, exports, notifications already shown, backups people made, or copies on devices you do not control.
- You can delete your account in the Android app: Settings → Delete account, confirmed with a code we email you. It happens at once: your account, username, profile and profile picture, devices and their keys, group memberships, blocks, sessions, and messages still waiting for you on the server are deleted, and your phone and linked browsers erase their PingDost data. Messages you already sent stay with the people who received them. A security record that the account was deleted is kept for 90 days, and abuse reports for their own limit. Copies of the account database in our nightly backups disappear within 7 days (section 4). Without the app, ask us at **[email]**.

## 4. Copies outside the database, and backups
- We back up the account database nightly and keep each backup for 7 days. Backups **exclude** waiting messages, attachment records and email codes. Security events and abuse reports can stay in a backup for up to 7 days after their 90-day limit.
- Waiting encrypted messages and attachments live on our server's disk. After deletion, encrypted remnants can stay for a limited time in the database's append-only log and in our hosting provider's server snapshots (kept for **[Hostinger backup retention]**). They remain end-to-end encrypted and unreadable to us.

## 5. Nearby messaging and relaying (optional, off by default)
If you turn on **Nearby messaging**, other PingDost phones in Bluetooth range can see that a PingDost phone is near and, once connected, your device's public key, which does not change. They cannot see your name, number, account or messages.
If you also turn on **Nearby relay**, your phone carries other people's encrypted messages and files for them. Relaying phones see routing information: rotating daily routing codes, packet IDs, times, sizes, hop counts and, for groups, group and session identifiers. They cannot read or alter the content.

## 6. Calls
Calls are end-to-end encrypted (WebRTC). When a direct connection is not possible, call data passes through our relay server (TURN), which sees both IP addresses and how much data flows, not the content. The relay sign-in name contains your user ID; error logs of the relay can contain it with your IP address and are kept about a week. On an iPhone, calls use Apple's CallKit call screen; PingDost keeps them out of the Phone app's recent calls (which iCloud syncs).

## 7. Third parties
| Service | What they get | Why |
|---|---|---|
| Hostinger (server hosting) | Everything in §2 as stored on our server's disk | Runs our server |
| MongoDB Atlas (database) | The database contents in §2 | Stores account metadata |
| Cloudflare | Web app requests, DNS | Serves the web app |
| Google Firebase Cloud Messaging | Your push token; a content-free "wake" signal and its timing | Wakes your Android device |
| Apple Push Notification service | Your iPhone's push tokens; a fixed "New message" or "Incoming call" notice and its timing, with no sender or content | Wakes your iPhone and rings incoming calls |
| Your browser's push service | Your push subscription; a content-free signal | Wakes the web app |
| Google Sign-In (optional) | Your sign-in with Google | If you choose it |
| Cloudinary | Your profile picture (public) | Hosts profile pictures |
| **[Email provider: ZeptoMail / Brevo]** | Your email address and the code we send | Email verification |
| Google Play (Android vitals) | Crash and performance data, **only** if you allowed your phone to share usage and diagnostics with Google | App stability; PingDost itself includes no crash-reporting or analytics SDK |

We do not sell data, show ads, or use analytics.

## 8. Your choices and rights
You can: see and revoke linked devices; turn off read receipts, last seen and typing indicators; turn Nearby and relaying on or off; block people; export a backup; ask for your account data or its deletion at **[email]**. **[Add the rights that apply in your jurisdiction (e.g. India's DPDP Act 2023, the EU GDPR) and how to complain to the regulator.]**

## 9. Children
PingDost is not meant for children under **[13/16/18, per the law where you offer it]**.

## 10. Security
End-to-end encryption uses the open-source vodozemac library (Olm and Megolm). Attachments use XChaCha20-Poly1305. The code is open source (AGPL-3.0) at **[repository URL]**. Report security problems as described in SECURITY.md. No system is perfectly secure; this policy lists the limits we know of.

## 11. Changes
We will post changes here and, for important ones, tell you in the app before they take effect.
